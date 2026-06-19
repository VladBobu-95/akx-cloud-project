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
| IA / asistente | **Ollama**: chat `qwen2.5-coder:14b` (*tool calling*) + embeddings `bge-m3` (RAG) + OCR `deepseek-ocr` (facturas) + descripción de fotos `llava` |
| Extracción de texto | `pdf-parse` (PDF) + `mammoth` (Word) + texto plano; imágenes: OCR con deepseek-ocr → si no hay texto real, descripción con llava → Tesseract de último recurso |
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
docker exec clouddrive-ollama ollama pull deepseek-ocr       # OCR de facturas (opcional, hay fallback)
docker exec clouddrive-ollama ollama pull llava              # describe fotos sin texto (opcional, hay fallback)
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
`AgregarFacturas` (tablas `facturas` y `lineas_factura`).

### Autenticación
Registro/login devuelven un JWT (7 días). Las contraseñas se guardan hasheadas con
bcrypt. El middleware `auth` protege las rutas y deja el `usuarioId` disponible para
que cada servicio filtre **solo los datos de ese usuario**. Rate limiting (solo en
producción): login máx. 10 intentos/15min por IP, registro máx. 5/hora por IP. El
perfil (`GET`/`PATCH /api/auth/perfil`) permite cambiar nombre, avatar (data URL
base64) y contraseña (mín. 8 caracteres) en la misma petición. Existe un campo `rol`
(`"user"`/`"admin"`) y un middleware `soloAdmin`, pero todavía no hay rutas que lo usen.

### Archivos (metadata + MinIO)
La subida es **transaccional**: se sube el binario a MinIO y se guarda la metadata en
Postgres; si Postgres falla, se limpia el objeto de MinIO (sin huérfanos). La descarga
se hace por **streaming a través de la API** (la API lee el objeto de MinIO y lo
canaliza al cliente; así funciona aunque MinIO solo sea accesible en la red interna de
Docker). Copiar duplica el binario (`copyObject`); mover/renombrar solo cambia la
metadata. El listado es **paginado** (totales en cabeceras `X-Total-*`). El borrado es
**soft-delete** (papelera, recuperable); el permanente elimina binario + fila. También
se pueden **descargar carpetas enteras como `.zip`** (generado al vuelo).

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
  nuevo sin contexto y el modelo hacía otra cosa.
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
- Herramientas: buscar/crear/mover/renombrar/copiar/eliminar archivos y carpetas, papelera
  (listar/restaurar/borrar/vaciar), `leer_archivo`, `estadisticas`, `buscar_semantica`,
  borrados masivos (`borrar_todo`, `borrar_todas_carpetas`, `borrar_todos_archivos`), y
  **facturas**: `escanear_factura`, `escanear_todas_facturas`, `obtener_factura`,
  `ventas_top`, `totales_facturas` y `clientes_top` (ranking de clientes por gasto
  total) — todas filtrables por factura, cliente, emisor, producto (solo `ventas_top`)
  y periodo. Cuando se resuelve un archivo concreto (p. ej. `obtener_factura`),
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
  - "borra el archivo viejo.txt"
  - "créame una nota llamada notas.md con esto: ..."
  - "lee el archivo notas.md" / "¿qué dice el contrato.docx?" / "qué dice factura_01.pdf"
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
  - "vacía la papelera" (borrado definitivo de TODO, no confundir con "restaura todo")
- **Búsqueda e info** — por significado del contenido (no solo por nombre), y uso de la cuenta:
  - "¿qué documento habla de impuestos?" / "¿dónde dice algo sobre el proyecto X?"
  - "resume lo que tengo sobre Y"
  - "estadísticas" / "¿cuánto espacio uso?"
- **Facturas** — escanear, ver/abrir una ya escaneada, y analítica filtrable:
  - "escanea factura_01" / "escanea todas las facturas"
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
- **Imágenes** — ver qué contienen, buscarlas por contenido, o tratarlas como factura:
  - "qué dice foto.jpg" / "muéstrame foto.jpg" (la descripción que se generó al
    subirla: la escrita a mano en el modal, o la automática — OCR si tenía texto
    real, descripción de llava si era una foto sin texto)
  - "resume lo que tengo sobre velas" / "qué imágenes hablan de X" (búsqueda
    semántica, igual que con documentos)
  - "escanea la factura foto.jpg" (con pista opcional si es difícil de leer; si no
    hay datos reales de una factura, ya no se inventa una)
  - Para que la descripción sea exacta sin esperar el OCR automático (puede tardar
    varios minutos en máquinas sin GPU potente), conviene escribirla a mano en el
    modal "¿Qué es esta imagen?" que aparece justo al subir una foto.

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
   Word, decodificación directa para texto plano) **en segundo plano** (no bloquea la subida).
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

## Estructura

```
backend/src/
  config/       env (Zod), database (TypeORM), minio (bucket)
  entities/     Usuario, Archivo, Carpeta, Factura, LineaFactura
  migrations/   InitialSchema → AddPerfilUsuario → CrearCarpetas → AgregarRagFragmentos →
                 MigrarEmbeddingMultilingue → AgregarFacturas
  middlewares/  auth (JWT), validarUUID, errorHandler
  routes/       auth, archivos (+carpetas, +buscar), chat, facturas
  controllers/  auth, archivos, chat, facturas
  services/     auth, archivos, carpetas, chat, extraccion (texto), rag (embeddings/búsqueda), facturas
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
- **Facturas** (`/api/facturas`) 🔒: `POST /escanear` (OCR + extracción de datos; rechaza
  con 422 si no hay datos reales de factura, en vez de inventarlos)
- `GET /health`: estado de la API y conexión a BD

## Tests

```bash
cd backend && npm test     # Jest + Supertest contra una BD de test aislada (clouddrive_test)
```

Requiere Postgres y MinIO levantados; la BD de test se crea sola (usa `synchronize`).

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
- [x] **Fase 4 — Facturas:** OCR con visión (deepseek-ocr), auto-escaneo al subir, analítica filtrable vía tools (`ventas_top`, `totales_facturas`, `clientes_top`), descripción de fotos sin texto (llava)
