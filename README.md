# CloudDrive — Backend (API + servicios)

Mini-OneDrive con chatbot IA: los archivos viven en MinIO, la metadata en Postgres,
un asistente (Ollama) gestiona archivos y carpetas mediante *tool calling*, y se puede
buscar por el **contenido** de los documentos (RAG con embeddings en pgvector).

## Stack

| Parte | Tecnología |
|---|---|
| Servidor HTTP / rutas | Express 5 + TypeScript (ts-node en dev, `tsc` en build) |
| ORM / base de datos | TypeORM + PostgreSQL 16 (imagen **pgvector**) |
| Almacenamiento de archivos | **MinIO** (S3-compatible), descarga por streaming desde la API |
| IA / asistente | **Ollama**: chat `qwen2.5-coder:14b` (*tool calling*) + embeddings `bge-m3` (RAG) + visión `granite3.2-vision` (rápido) → `deepseek-ocr` (OCR fiel de facturas) → **Tesseract.js** (red de seguridad por CPU si los dos modelos anteriores se quedan cortos) |
| Extracción de texto | `pdf-parse` (PDF) + `mammoth` (Word) + texto plano; imágenes: cascada de 3 pasadas — granite transcribe/describe, si parece factura deepseek-ocr re-lee para no fallar dígitos, y si ninguno de los dos da algo aprovechable entra Tesseract.js (OCR clásico, preprocesado con sharp). Se puede añadir una descripción a mano (`PATCH .../descripcion`) |
| Subida de ficheros | Multer (en memoria, filtro MIME, límite 50 MB) |
| Auth | JWT (`jsonwebtoken`) + bcrypt |
| Validación | Zod (entrada y variables de entorno) |
| Seguridad HTTP | Helmet, CORS, `express-rate-limit` |
| Orquestación | Docker Compose |

## Arquitectura y flujo

```
[Angular] → [API Express] → [Postgres + pgvector: metadata + embeddings]
                         ↘ [MinIO: binarios de archivos]
                         ↘ [Ollama: chat (tool calling) + embeddings (RAG)]
```

Flujo de una petición: **ruta → middleware (auth JWT, validación) → controller → service → Postgres/MinIO**.
La IA nunca toca la BD directamente: la API le expone "herramientas" (crear carpeta,
mover archivo, buscar por contenido…) que ejecutan la lógica real con aislamiento por usuario.

## Arranque

```bash
cp .env.example .env         # rellenar contraseñas y JWT_SECRET (mín. 16 chars)
docker compose up -d         # db + minio + api + web + ollama (en casa, vía override)
docker exec clouddrive-ollama ollama pull qwen2.5-coder:14b   # chatbot (o qwen2.5:3b en máquinas pequeñas)
docker exec clouddrive-ollama ollama pull bge-m3             # embeddings (búsqueda)
docker exec clouddrive-ollama ollama pull granite3.2-vision  # visión: 1ª pasada (transcribe/describe)
docker exec clouddrive-ollama ollama pull deepseek-ocr       # visión: OCR fiel de facturas (2ª pasada)
```

Desarrollo con hot-reload (fuera de Docker): `cd backend && npm install && npm run dev`
(en el `.env`: `DB_HOST=localhost`, `DB_PORT=5433`, `MINIO_ENDPOINT=localhost`).

Verificar: API `http://localhost:3000/health` · MinIO `http://localhost:9001` ·
Adminer (visor BD) `http://localhost:8080` · Ollama `http://localhost:11434`.

## Cómo funcionan las partes clave

### Configuración (`config/env.ts`)
Las variables de entorno se validan con Zod al arrancar. Si falta alguna obligatoria,
el proceso muere indicando cuál: nunca arranca con configuración incompleta.

### Migraciones (`config/database.ts` + `migrations/`)
En dev/prod el esquema se gestiona con migraciones (`migrationsRun: true`), no con
`synchronize`. Al arrancar sobre una BD vacía se aplican en orden:
`InitialSchema` (crea `usuarios` y `archivos`) → `AddPerfilUsuario` → `CrearCarpetas` →
`AgregarRagFragmentos` (extensión `vector` + tabla `fragmentos`) →
`MigrarEmbeddingMultilingue` (dimensión del vector a 1024 para bge-m3) →
`AgregarFacturas` (tablas `facturas` y `lineas_factura`) → `HabilitarUnaccent` →
`AgregarEstadoEscaneo` → `AgregarDescripcionManual` →
`AgregarTareasYEstadoIndexado` (tabla `tareas` de la cola durable + columnas
`estadoIndexado`/`indexadoEn` en `archivos`) →
`AgregarChatPendientes` (tabla `chat_pendientes`) →
`IndiceHashArchivos` (índice para la deduplicación por hash).

### Autenticación
Registro/login devuelven un JWT (7 días). Las contraseñas se guardan hasheadas con
bcrypt. El middleware `auth` protege las rutas y deja el `usuarioId` disponible para
que cada servicio filtre **solo los datos de ese usuario**. Rate limiting (solo en
producción): login máx. 10 intentos/15min por IP, registro máx. 5/hora por IP. Además,
los endpoints que consumen GPU/disco (chat, escanear y subir) tienen rate-limit **por
usuario** y un **cap de backlog** (rechazan con 429 si el usuario ya tiene demasiadas
tareas en cola), para que uno solo no sature la GPU (`middlewares/limites.middleware.ts`).
El perfil (`GET`/`PATCH /api/auth/perfil`) permite cambiar nombre, avatar y contraseña
(mín. 8 caracteres) en la misma petición. El **avatar** es un data-URL base64 que se
**valida** (formato, mime PNG/JPEG/WEBP por magic bytes y tope de 2 MB decodificados),
no se acepta cualquier cosa. Existe un campo `rol` (`"user"`/`"admin"`) y un middleware
`soloAdmin`, pero todavía no hay rutas que lo usen.

### Archivos (metadata + MinIO)
La subida es **transaccional**: se sube el binario a MinIO y se guarda la metadata en
Postgres; si Postgres falla, se limpia el objeto de MinIO (sin huérfanos). La descarga
se hace por **streaming a través de la API** (la API lee el objeto de MinIO y lo
canaliza al cliente; así funciona aunque MinIO solo sea accesible en la red interna de
Docker). Copiar duplica el binario (`copyObject`); mover/renombrar solo cambia la
metadata. El listado es **paginado** (totales en cabeceras `X-Total-*`). El borrado es
**soft-delete** (papelera, recuperable); el permanente elimina binario + fila. También
se pueden **descargar carpetas enteras como `.zip`** (generado al vuelo). La subida
**deduplica por hash** (SHA-256 del contenido): si ya tienes un archivo vivo idéntico,
no se vuelve a subir ni a reprocesar (OCR/embeddings) — se reutiliza el existente y se
avisa, evitando además duplicar facturas en la analítica.

### Carpetas
Rutas virtuales tipo `/facturas/2026` (solo metadata, sin carpetas reales). Operaciones
de borrar/vaciar/mover/copiar comprueban que la carpeta **origen exista** antes de actuar
(si no, devuelven 404 en vez de fingir éxito y crear el destino vacío). `vaciar_carpeta`
acepta `/` como ruta especial para vaciar solo los archivos sueltos en la raíz, sin tocar
el contenido de las carpetas.

### Chatbot (`services/chat.service.ts`)
Bucle de *tool calling* contra Ollama: el modelo recibe el mensaje + el catálogo de
herramientas, decide cuáles llamar, la API las ejecuta de verdad y devuelve el
resultado; se repite hasta que el modelo da la respuesta final. Las acciones reales se
acumulan y se devuelven al frontend (las "✓"). Medidas de fiabilidad:

- Modelo **`qwen2.5-coder:14b`** en el servidor con GPU (configurable con `OLLAMA_MODEL`;
  debe soportar tool calling). `temperature: 0` y `keep_alive: 30m`.
- **Solo se envía el último mensaje** al modelo (no el historial): reenviar turnos previos
  hacía que modelos pequeños re-ejecutaran acciones anteriores (p. ej. repetir `borrar_todo`).
- **Pre-flights deterministas** por regex para frases muy comunes que el modelo no
  invocaba de forma fiable: borrados masivos ("borra todo" / "borra todas las carpetas"
  / "borra todos los archivos", cada uno con un alcance distinto), borrar **un**
  archivo o carpeta concretos ("borra el archivo X" / "borra la carpeta X" — el
  modelo casi nunca llamaba a la tool para esto, a veces ni emitía ninguna llamada
  válida), crear una nota/archivo de texto ("créame una nota llamada X con esto:
  ..." — el modelo intentaba *leer* un archivo que aún no existía en vez de
  crearlo), listar todo (archivos + carpetas, con o sin acotar a una carpeta —
  admite tanto "de la carpeta X" como "dentro de X" sin la palabra "carpeta"),
  "¿qué hay en la papelera?", restaurar vs. borrar definitivamente de la papelera
  (son acciones opuestas que el modelo confundía pese a la instrucción explícita
  del prompt — se llegó a ver "borra X de la papelera" *restaurando* el archivo),
  comprobar si existe/dónde está un archivo, "abre/muéstrame factura X" (lee
  siempre de BD, nunca relanza un escaneo OCR), totales de varias facturas
  nombradas en la misma frase ("totales de factura_01 y factura_02" sin un verbo
  claro como "dame" podía interpretarse como abrir solo la primera), y búsqueda
  semántica por tema ("resume lo que tengo sobre X" / "qué documento habla de X" —
  el modelo a veces pedía más detalles al usuario en vez de buscar). Sin estos el
  modelo a veces "comprobaba" la existencia de un archivo escaneándolo con OCR
  (lento, y podía tirar el proceso en servidores sin GPU), o devolvía contenido de
  facturas no relacionado.
- **Analítica de facturas ventas vs. compras**: cada factura se clasifica como venta
  (la empresa emite) o compra (recibe), y las consultas se separan. Ventas:
  "cuánto he facturado / vendido", "qué vendí más", "mi mejor cliente" →
  `totales_facturas`/`ventas_top`/`clientes_top`. Compras: "cuánto he gastado",
  "qué he comprado más", "mis proveedores / a quién le compro más" →
  `totales_compras`/`compras_top`/`proveedores_top`. Los resúmenes agregados
  (`resumen-ventas.md` y `resumen-compras.md`) también están separados. Todo agrupa
  por moneda (nunca suma divisas distintas).
- **Verbos con pronombre pegado**: "borra todo" funcionaba pero "bórralo todo" no
  (el pronombre enclítico desplaza la tilde y rompe el límite de palabra). Todos los
  verbos de los pre-flights anteriores se comparan ahora sobre el mensaje sin tildes
  y aceptan el pronombre pegado (borra/bórralo, restaura/restáuralo, abre/ábrelo,
  busca/búscalo, crea/créalo, lista/lístalo...).
- **Resolución flexible de archivos/carpetas** (`resolverArchivo`/`resolverCarpeta`):
  busca por nombre (no la ruta completa) en todas las carpetas, con fallback
  archivo↔carpeta si una operación de carpeta en realidad apunta a un archivo, y
  fallback a búsqueda por nombre suelto si el modelo antepone "/" a un nombre que
  no es una ruta absoluta real (ej. pasa "/tmp" cuando la carpeta está en
  "/demo/tmp"). Si hay varias coincidencias, la pregunta de aclaración con las
  opciones reales se construye **en el servidor** (el modelo a veces preguntaba
  "¿cuál quieres?" sin listar ninguna), y se recuerda qué se estaba pidiendo
  (tool + argumentos) para completarlo en el turno siguiente cuando el usuario
  responde con la opción elegida — antes esa respuesta se trataba como un mensaje
  nuevo sin contexto y el modelo hacía otra cosa. Si no hay coincidencia exacta,
  se sugieren nombres parecidos por similitud ("¿querías decir...?", tolera
  erratas). La aclaración se muestra también como **tabla clicable** (botón
  "Elegir", o "Resumen"/"Abrir" si la tool solo consulta) además del texto, y se
  puede rechazar con "no"/"déjalo"/"cancela" sin que el chat invente una acción.
- **Comandos compuestos**: una sola frase puede encadenar varias acciones
  ("ábreme presupuesto.pdf y contrato.docx", "crea la carpeta demo y copia
  factura_01 ahí y borra viejo.txt") — se ejecutan todas en orden, avisando con
  ⚠️ de la que falle, en vez de que el modelo solo atienda la primera.
- **Si falta un dato que el usuario no dio** (ej. "cambia el nombre de
  factura_03" sin decir el nombre nuevo), el chat lo pregunta y usa la
  respuesta del siguiente mensaje para completar la acción, en vez de seguir
  adelante con el argumento vacío (antes esto renombraba el archivo a la
  cadena literal "undefined").
- **Copiar un archivo** sin indicar nombre para la copia la llama automáticamente
  `"<original> (copia)"` (y "(copia 2)", "(copia 3)"... si ya existe) para no
  dejar dos archivos con el mismo nombre en la misma carpeta.
- **Parser de respaldo**: si el modelo emite las tool calls como texto JSON en `content`
  en vez de en `tool_calls`, se extraen (escáner de llaves balanceadas) y se ejecutan
  igual. Además, los nombres de tool alucinados (`mover_factura` en vez de
  `mover_archivo`) se remapean por regex en vez de descartarse.
- **Bypass pattern**: si todas las tools de una iteración devuelven `resumen`, ese texto/
  markdown (con `€` server-side en facturas) se devuelve directo sin otra llamada al
  modelo. Además de en facturas, se usa en **todas** las operaciones de archivos/carpetas/
  papelera (devuelven `resumen: "Hecho."`) para evitar que el modelo redacte su propia
  confirmación y a veces invente texto no relacionado con la acción real.
- **`leer_archivo` reutiliza el texto ya extraído** (mismo `textoExtraido` que usa el RAG,
  vía `pdf-parse`/`mammoth`) para PDF y DOCX, no solo texto plano: antes rechazaba
  cualquier archivo que no fuera `text/*`/json/xml/markdown.
- **Filtros de cliente/emisor/producto en facturas insensibles a tildes** (extensión
  `unaccent` de Postgres): "Tecnologias" (sin tilde, lo más común al escribir rápido)
  encuentra igual "Tecnologías".
- **Confirmación de operaciones masivas irreversibles**: vaciar la papelera (borrado
  DEFINITIVO) pide un "sí" explícito antes de ejecutarse; el resto (incl. "borra todo",
  que va a la papelera y se puede deshacer) sigue siendo instantáneo. La intención
  pendiente se guarda en la BD (`chat_pendientes`), igual que las aclaraciones y los
  datos que faltan, así que **sobreviven a un reinicio** (antes vivían en memoria).
- **Capa de detección testeable** (`services/chat.deteccion.ts`): los regex que detectan
  las intenciones más peligrosas (borrados masivos, papelera) se extrajeron a funciones
  puras con **tests unitarios de frases** (sin BD/Ollama), para que tocar una frase no
  rompa otra sin avisar.
- Herramientas: buscar/crear/mover/renombrar/copiar/eliminar archivos y carpetas, papelera
  (listar/restaurar/borrar/vaciar), `leer_archivo`, `estadisticas`, `buscar_semantica`,
  borrados masivos (`borrar_todo`, `borrar_todas_carpetas`, `borrar_todos_archivos`), y
  **facturas**: `escanear_factura`, `escanear_todas_facturas`, `obtener_factura`,
  `ventas_top`, `totales_facturas` y `clientes_top` (ranking de clientes por gasto
  total) — todas filtrables por factura, cliente, emisor, producto (solo `ventas_top`)
  y periodo. El escaneo desde el chat se **encola en segundo plano** (responde al
  instante y el progreso se ve en la columna "Estado", igual que el botón "Escanear"
  del explorador): hacerlo síncrono colgaba la petición hasta el 504 de nginx cuando
  había varias facturas. `escanear_todas_facturas` solo procesa **PDFs** por defecto;
  para incluir imágenes hay que pedirlo ("escanea todas las imágenes" → solo imágenes;
  "escanea todo" → ambos). Cuando se resuelve un archivo concreto (p. ej. `obtener_factura`),
  la respuesta del chat incluye `archivo: {id, nombre}` y el frontend muestra un botón
  para abrirlo en una pestaña nueva, igual que en el explorador.

**Cambiar de modelo:** edita `OLLAMA_MODEL` en `.env`, haz
`docker exec clouddrive-ollama ollama pull <modelo>` y `docker compose up -d api`.

#### Qué puede pedirle el usuario al chatbot

No hace falta usar nombres técnicos ni dar la ruta completa de nada: basta con
mencionar el nombre del archivo/carpeta y pedirlo en lenguaje natural. Por categoría,
con ejemplos reales de frases que entiende:

- **Archivos** — buscar/listar, copiar, mover, renombrar, enviar a la papelera, crear
  una nota/documento de texto (.md o .txt) con contenido, leer su contenido:
  - "¿tengo un archivo llamado factura_01?" / "busca el archivo presupuesto.pdf"
  - "¿dónde está el archivo contrato.docx?"
  - "lista mis archivos" / "qué archivos tengo en /facturas"
  - "copia factura_03 a /2026" (con la ruta destino directa; la variante "a **la
    carpeta** 2026" es menos fiable con modelos pequeños — ver Limitaciones)
  - "mueve presupuesto.pdf a /clientes"
  - "cambia el nombre de factura_03 a factura_033"
  - "cambia el nombre de factura_03" (sin decir el nombre nuevo: el chat te
    pregunta "¿qué nombre quieres ponerle?" y lo aplica con tu siguiente respuesta)
  - "haz una copia de factura_03" (la copia se llama "factura_03 (copia)" sola)
  - "borra el archivo viejo.txt"
  - "créame una nota llamada notas.md con esto: ..."
  - "lee el archivo notas.md" / "¿qué dice el contrato.docx?" / "qué dice factura_01.pdf"
  - "ábreme presupuesto.pdf y contrato.docx" / "crea la carpeta demo y copia
    factura_01 ahí y borra viejo.txt" (varias acciones en un solo mensaje)
- **Carpetas** — crear, eliminar entera (con su contenido), vaciar dejando la carpeta,
  mover, renombrar, copiar, listar todas. No hace falta dar la ruta completa para
  operar sobre una que ya existe, solo su nombre:
  - "créame una carpeta llamada demo" (si no dices dónde, se crea en la raíz)
  - "crea la carpeta /facturas/2026"
  - "lista todas las carpetas"
  - "borra la carpeta tmp" (carpeta + contenido, a la papelera)
  - "vacía la carpeta tmp" (borra el contenido, la carpeta se queda)
  - "mueve la carpeta tmp dentro de demo"
  - "cambia el nombre de la carpeta tmp a temporal"
  - "lista todo lo que tengo dentro de demo11" / "pásame todo lo que tengo en la raíz"
- **Borrados masivos** — cada uno con un alcance distinto:
  - "borra todo, quiero empezar de cero" (archivos y carpetas, todo)
  - "borra todas las carpetas" (con su contenido; lo suelto en la raíz no se toca)
  - "borra todos los ficheros" (archivos; las carpetas se quedan vacías)
- **Papelera** — listar, restaurar, borrar definitivamente (irreversible), vaciar entera:
  - "¿qué hay en la papelera?"
  - "restaura factura_01" / "recupera factura_01"
  - "restaura todos los ficheros" / "recupera toda la papelera" (recupera TODO de golpe)
  - "borra factura_01 de la papelera" (borrado definitivo, no restaura)
  - "vacía la papelera" (borrado definitivo de TODO; **pide confirmación** —responde
    "sí"— antes de borrar, no confundir con "restaura todo")
- **Búsqueda e info** — por significado del contenido (no solo por nombre), y uso de la cuenta:
  - "¿qué documento habla de impuestos?" / "¿dónde dice algo sobre el proyecto X?"
  - "resume lo que tengo sobre Y"
  - "estadísticas" / "¿cuánto espacio uso?"
- **Facturas** — escanear, ver/abrir una ya escaneada, y analítica filtrable:
  - "escanea factura_01" / "escanea todas las facturas" (se ponen a escanear en
    segundo plano; "escanea todas las facturas" solo procesa PDFs — di "escanea
    todas las imágenes" para las imágenes, o "escanea todo" para ambos)
  - "muéstrame factura_03" / "abre factura_03" (lee de BD al instante; si no está
    escaneada te lo dice en vez de escanearla sola, y aparece un botón para abrirla
    tal cual en una pestaña nueva)
  - "¿qué producto vendí más?" / "ranking de lo menos vendido"
  - "¿qué es lo que más se vende en julio?" / "lo más vendido en 2026" (ranking por periodo; el mes se entiende por su nombre)
  -  Pasame el total de todo lo que he facturado
  -  Pasame lo que he facaturado en abril 
  -  Que cliente ha facturado mas? 
  -  Que facturas hablan de X? 
  - "¿cuánto le he facturado a Ferretería Sánchez?"
  - "total facturado en 2026" / "totales de factura_01 y factura_02"
  - "top clientes por gasto total" / "¿qué cliente me ha comprado menos?" / "¿quién es mi mejor cliente?"
  - "pásame todas las facturas en yen / dólares / euros"	Listado filtrado por divisa
  - "abre facturas de junio 2026 de Suministros López SA"	Listado periodo + cliente
  - "abre facturas de junio 2026 Suministros López SA" (sin "de")	Igual — separa el periodo del nombre del cliente
  - "facturas de Acme en dólares"	Listado cliente + divisa (quita "en dólares" del nombre)
  - "facturas de la carpeta 2026 en yenes"	Listado carpeta + divisa
  - "cuánto he facturado en dólares"	Totales en USD
  - "cuánto he facturado en marzo de Acme en euros"	Totales periodo + cliente + divisa
  - "cuánto he facturado" (en total)	Totales de todo, agrupados por moneda
  - "lo más vendido en dólares"	Ranking de productos filtrado por divisa
  - cuantos led panel he vendido 
  - resumen facturas de junio a julio
  - cuánto facturé de junio a julio
  - qué vendí más de 2005 a 2026
  - facturas con bombillas de junio 2026
- **Imágenes** — ver qué contienen, buscarlas por contenido, o tratarlas como factura:
  - "qué dice foto.jpg" / "muéstrame foto.jpg" (la descripción que se generó al
    subirla: el OCR automático si tenía texto real, o la escrita a mano si no lo tenía)
  - "resume lo que tengo sobre velas" / "qué imágenes hablan de X" (búsqueda
    semántica, igual que con documentos)
  - "escanea la factura foto.jpg" (con pista opcional si es difícil de leer; si no
    hay datos reales de una factura, ya no se inventa una)
  - Las fotos se describen **automáticamente** al subir (1ª pasada de visión con
    granite; si esa pasada se queda corta —vacía, una meta-descripción sin contenido
    real, o una negación de texto sin nada más detrás—, entra Tesseract.js como red de
    seguridad por CPU). Si quieres afinar esa descripción para encontrarla mejor en el
    buscador, en el explorador: clic derecho → **Añadir descripción**.

**Limitaciones conocidas del chatbot** (verificadas probando todas las frases de
arriba contra el modelo real): copiar/mover con la frase exacta "a **la carpeta**
X" (en vez de "a /X" o "a X" directo) falla de forma consistente con modelos
pequeños como `qwen2.5-coder:7b` — no hay pre-flight para esto todavía. Pedir
"lee X" sobre un archivo con contenido muy corto/trivial a veces solo confirma
"lo he leído" en vez de mostrarlo (con contenido más rico, como una factura, sí
lo muestra bien).

### Búsqueda semántica / RAG (`services/rag.service.ts` + `extraccion.service.ts`)
Permite buscar por el **significado del contenido**, no solo por el nombre del archivo:

1. **Al subir** un archivo se extrae su texto (`pdf-parse` para PDF, `mammoth` para
   Word, decodificación directa para texto plano) **en segundo plano**, a través de la
   **cola durable** (ver más abajo): no bloquea la subida y, si la API se reinicia a
   mitad, el indexado se reanuda en vez de perderse.
2. El texto se **trocea** en fragmentos (~1000 caracteres con solape) y cada fragmento se
   convierte en un **embedding** (vector) con `bge-m3` (multilingüe). Se guardan en la
   tabla `fragmentos` (`embedding vector(1024)`, índice HNSW por coseno).
3. **Buscar**: la consulta también se convierte en vector y se piden los fragmentos más
   cercanos (`<=>` de pgvector). La búsqueda es **híbrida**: un fragmento entra si es
   semánticamente parecido (por encima de `MIN_SCORE`) **o** si contiene literalmente el
   texto buscado (`ILIKE`). Así "pintura" encuentra la factura que la menciona, y las
   consultas conceptuales también funcionan, sin devolver resultados irrelevantes.
4. Se usa desde el **chatbot** (herramienta `buscar_semantica`) y desde el **buscador de
   la UI** (`GET /api/archivos/buscar?q=`). Solo se indexan las subidas nuevas; al borrar
   un archivo, sus fragmentos se eliminan en cascada (FK `ON DELETE CASCADE`).

### Procesado en segundo plano: cola durable (`services/tareas.service.ts`)
El trabajo pesado de una subida (extraer texto, generar embeddings, auto-escanear
facturas) usa la GPU/Ollama y es lento, así que **no** se hace dentro de la petición.
En vez de lanzarlo "al aire" en memoria (se perdía si la API se reiniciaba), se apunta
una **tarea en la tabla `tareas`** y un **worker** la procesa:

- El worker sondea la tabla (con despertar inmediato al encolar) y coge las tareas de
  una en una (`WORKER_CONCURRENCIA`, 1 por defecto) para **no saturar la GPU**.
- Para cada tarea **relee el binario desde MinIO** (no depende de un buffer en memoria),
  así es **idempotente y sobrevive a reinicios**: al arrancar, las tareas que quedaron
  `en_proceso` por un corte se reencolan.
- **Reintenta con backoff** si Ollama falla; tras agotar `WORKER_MAX_INTENTOS` marca la
  tarea (y el archivo) como `error`, visible en la columna "Estado" del explorador.
- El estado del indexado se refleja en `archivos.estadoIndexado` (`pendiente`/`indexando`/
  `indexado`/`error`). El escaneo manual desde el chat o el explorador también encola
  aquí. Sustituye a las antiguas colas en memoria, conservando el orden por fases que
  evita que Ollama cambie de modelo por archivo (prioridades).

### Mantenimiento periódico (`services/reconciliacion.service.ts`)
La subida (MinIO→Postgres) y el borrado (MinIO→Postgres) no son atómicos: un corte entre
los dos pasos puede dejar un binario **huérfano** (objeto en MinIO sin fila) o una fila
**colgada** (apunta a un objeto que ya no existe). Un job periódico
(`MANTENIMIENTO_INTERVAL_HORAS`) borra los huérfanos claros (con margen de antigüedad
para no tocar subidas en vuelo) y avisa de las filas colgadas. Incluye una **retención
de papelera** opt-in (`RETENCION_PAPELERA_DIAS`, 0 = desactivada): purga definitivamente
lo que lleve más de N días en la papelera, que de otro modo no se vacía sola nunca.

## Estructura

```
backend/src/
  config/       env (Zod), database (TypeORM), minio (bucket)
  entities/     Usuario, Archivo, Carpeta, Factura, LineaFactura, Tarea (cola durable), ChatPendiente
  migrations/   InitialSchema → AddPerfilUsuario → CrearCarpetas → AgregarRagFragmentos →
                 MigrarEmbeddingMultilingue → AgregarFacturas → HabilitarUnaccent →
                 AgregarEstadoEscaneo → AgregarDescripcionManual →
                 AgregarTareasYEstadoIndexado → AgregarChatPendientes → IndiceHashArchivos
  middlewares/  auth (JWT), validarUUID, errorHandler, limites (rate-limit + backlog)
  routes/       auth, archivos (+carpetas, +buscar), chat, facturas
  controllers/  auth, archivos, chat, facturas
  services/     auth, archivos, carpetas, chat, chat.deteccion (intenciones puras),
                 chatPendientes, extraccion (texto), rag (embeddings/búsqueda), facturas,
                 tareas (worker de la cola durable), reconciliacion (mantenimiento)
docker-compose.yml          db + minio + api + web (frontend nginx)
docker-compose.override.yml ollama + adminer (solo en local)
```

## Endpoints (resumen)

- **Auth** (`/api/auth`): `POST /registro`, `POST /login`, `GET /perfil` 🔒, `PATCH /perfil` 🔒
- **Archivos** (`/api/archivos`) 🔒: `POST /subir`, `GET /` (paginado, `?carpeta=`),
  `GET /buscar?q=` (búsqueda semántica/RAG), `GET /:id`, `GET /:id/descargar` (streaming
  del binario a través de la API), `PATCH /:id`, `PATCH /:id/descripcion` (describir a
  mano una imagen sin texto legible, se indexa para RAG), `DELETE /:id` (papelera),
  `DELETE /:id/permanente`; papelera: `GET /papelera`, `PATCH /:id/restaurar` (si ya
  hay un activo con el mismo nombre, le pone sufijo "(restaurado)"), `DELETE /papelera`
- **Carpetas** (`/api/archivos/carpetas`) 🔒: crear/listar/mover/eliminar
- **Chat** (`/api/chat`) 🔒: conversación con el asistente → `{respuesta, acciones[], archivo?: {id, nombre}}`
- **Facturas** (`/api/facturas`) 🔒: `POST /escanear` (responde **202** y encola el
  escaneo en segundo plano — OCR + extracción de datos + **clasificación venta/compra**;
  el estado final se ve en la columna "Estado", y marca `no_factura` si no hay datos
  reales en vez de inventarlos), `GET /` (listado paginado y filtrable — `?tipo=venta|compra|desconocido`
  para las pestañas de la página Facturas y `?...` para la paginación de tablas del chat),
  `GET /:id` (detalle con líneas), `PATCH /:id` (**edición manual**: corrige
  emisor/cliente/tipo/importes/líneas y regenera los resúmenes)
- `GET /health`: estado de la API y conexión a BD

## Tests

```bash
cd backend && npm test     # Jest + Supertest contra una BD de test aislada (clouddrive_test)
```

Requiere Postgres y MinIO levantados; la BD de test se crea sola (usa `synchronize`).
Cubren auth, archivos, deduplicación, cap de backlog, confirmación de vaciar papelera,
validación de avatar y reconciliación/retención; la detección de intenciones del chat
(`chat.deteccion`) y las **heurísticas de facturas** (`facturas.heuristicas`:
clasificación venta/compra, anclaje emisor/cliente por "Registro Mercantil", CIF,
idioma) se testean de forma pura (sin BD ni Ollama).

## Despliegue (servidor, acceso por IP, todo en Docker)

Monorepo: un único clon en el servidor (`backend/` y `frontend/` ya están dentro). El
servicio `web` del `docker-compose.yml` construye el frontend desde `./frontend`.

```bash
cp .env.example .env        # editar OLLAMA_URL al Ollama externo del servidor (con GPU)
rm docker-compose.override.yml   # en el servidor NO se usa Ollama en contenedor
docker compose up -d --build     # db + minio + api + web
docker exec <ollama-del-servidor> ollama pull qwen2.5-coder:14b   # o el modelo que toque
docker exec <ollama-del-servidor> ollama pull bge-m3
```

La API apunta al Ollama externo vía `OLLAMA_URL=http://host.docker.internal:11434`
(el servicio `api` ya define `extra_hosts: host.docker.internal:host-gateway` para
poder alcanzarlo en Linux). Está detrás de nginx (servicio `web`), por eso
`app.set("trust proxy", 1)` en `app.ts` — necesario para que `express-rate-limit` lea
bien la IP real (`X-Forwarded-For`). Los puertos del host son configurables por `.env`
(`WEB_PORT_HOST`, `API_PORT_HOST`, `MINIO_PORT_HOST`, etc.) para evitar choques con
otros servicios. **No editar archivos a mano en el servidor**: el flujo es local →
commit → push → `git pull` en el servidor (evita conflictos de merge), luego
`docker compose build api && docker compose up -d api` para aplicar cambios de código,
o solo `docker compose up -d api` si solo cambió el `.env` (no recarga código).

El servicio `web` (nginx) sirve el frontend en el **puerto 80** y hace de proxy de
`/api` hacia la API (mismo origen, sin CORS). Abrir solo el 80 (y el 3000 si se quiere la
API directa); no exponer 5433 (Postgres) ni 9000 (MinIO).

## Fases

- [x] **Fase 1 — Drive básico:** auth JWT, subir/descargar/listar/carpetas, papelera, tests
- [x] **Fase 2 — Chatbot:** Ollama + tool calling sobre archivos y carpetas
- [x] **Fase 3 — RAG:** extracción de texto (PDF/Word/texto), embeddings (bge-m3 + pgvector), búsqueda híbrida
- [x] **Fase 4 — Facturas:** visión en cascada de 3 pasadas (granite3.2-vision → deepseek-ocr para facturas → Tesseract.js como red de seguridad por CPU), auto-escaneo al subir, analítica filtrable vía tools (`ventas_top`, `totales_facturas`, `clientes_top`), descripción de fotos a mano opcional
- [x] **Fase 5 — Robustez:** cola de trabajos durable en Postgres + worker (reintentos, backoff, sobrevive a reinicios) que sustituye al procesado en memoria, estado de indexado en el explorador, estado del chat fuera de memoria, deduplicación por hash al subir, rate-limit + cap de backlog en los endpoints caros, confirmación para vaciar la papelera, validación del avatar, reconciliación MinIO↔Postgres + retención de papelera, y detección de intenciones del chat extraída a un módulo puro con tests
