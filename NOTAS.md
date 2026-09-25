# AKX Cloud — Notas técnicas y decisiones

> El detalle y el **porqué** de cada fix. Este archivo **no** se carga en cada sesión
> (a diferencia de `CLAUDE.md`); el `CLAUDE.md` remite aquí cuando hace falta el detalle.

---

## Chat por SQL (`chat.service.ts`)

Sustituye al chat anterior (tools + ~160 regex de pre-flights, 4.000 líneas) desde la
migración `1779000000000-ChatSql`. El modelo (`OLLAMA_MODEL`, por defecto `qwen3:14b`)
ya no llama a funciones: **escribe SQL de solo lectura** y redacta la respuesta.

**Flujo** (`chatear`):
1. Capacidad maestra `chat` (403 si falta), antes de llamar a la IA.
2. Prompt de sistema con el esquema de las vistas `chat.*`, la fecha de hoy (Europe/Madrid),
   el nombre/CIF de la empresa, reglas SQL y ejemplos. Las partes de facturas/contenido solo
   aparecen si el rol tiene `facturas`/`busqueda`.
3. Se envían los **últimos 8 mensajes** (usuario y bot): el chat es de solo lectura, así que
   reenviar el historial ya no puede repetir acciones (el motivo por el que antes solo se
   mandaba el último mensaje) y permite preguntas de seguimiento ("¿y en mayo?").
4. Si el modelo responde con un bloque ```` ```sql ````, se ejecuta y se le devuelven las filas
   (máx. 25 al modelo, textos recortados) o el error de Postgres para que corrija. Hasta
   **4 consultas** por mensaje; en la 5ª vuelta se le obliga a responder.
5. Respuesta `{respuesta, tabla?}`: `tabla` = última consulta con varias filas (o con
   `archivo_id`), hasta 200 filas. El front la pinta bajo el texto con botón "Abrir" si hay
   `archivo_id`; las columnas `*_id` no se muestran. n8n/Telegram la recibe además en markdown
   dentro de `respuesta` (`tablaAMarkdown`).

**Frontera de seguridad (multi-tenant)** — el SQL lo puede dirigir el usuario con su mensaje,
así que la protección está en la BD, no en el prompt:
- El SQL corre con el rol **`ateka_chat`** por una conexión propia (`config/chatDb.ts`). Es un
  usuario de login propio (contraseña = HMAC de `JWT_SECRET`, fijada al arrancar con
  `prepararRolChat`): con `SET ROLE` sobre la conexión principal, un `RESET ROLE` o
  `set_config('role', …)` en el SQL recuperaría todos los permisos.
- `ateka_chat` solo tiene `SELECT` sobre las vistas del esquema **`chat`** (`archivos`, `carpetas`,
  `carpetas_compartidas`, `facturas`, `lineas_factura`), nada sobre las tablas reales.
- Cada vista filtra por la fila de **`chat_accesos`** cuyo token (UUID aleatorio, 5 min, se borra
  al acabar) está en `app.chat_token`. `ateka_chat` no puede leer `chat_accesos`: aunque el SQL
  cambie ese ajuste, sin el token de otro usuario las vistas vuelven vacías. La fila guarda
  también las carpetas compartidas accesibles y los permisos `puedeFacturas`/`puedeContenido`.
- Vistas con `security_barrier` (un filtro del modelo con un cast que falla no se evalúa antes
  que el de la vista, y no filtra datos ajenos por el mensaje de error).
- Una sola sentencia: se ejecuta como `SELECT * FROM (<sql>) LIMIT $1` con parámetro → protocolo
  extendido de pg, que rechaza varias sentencias. Transacción `READ ONLY`,
  `default_transaction_read_only` y `statement_timeout = 10s` en el rol.
- Probado en `tests/chat.sql.test.ts` (aislamiento entre usuarios, tablas reales, sentencias
  encadenadas, escrituras, cambio de rol).

**Capacidades en el chat**: `facturas` → la vista `chat.facturas` devuelve filas;
`busqueda` → la columna `chat.archivos.contenido` (texto extraído + descripción manual) viene
rellena. `gestion_archivos` no aplica: el chat no modifica nada (para mover/borrar/subir remite
al explorador).

**Modelo**: `OLLAMA_THINK=true` activa el modo pensamiento de qwen3 (mejor SQL en preguntas
difíciles, bastante más lento). Solo se manda `think` a modelos que lo soportan
(`soportaThink`, vía `/api/show`). `OLLAMA_NUM_CTX` (8192) es el mismo para el chat y la
extracción de facturas: si difiriera, Ollama recargaría el modelo al alternar.

---

## Buscador del explorador (`contenido.service.ts`)

Sin IA desde que se quitó la búsqueda semántica (bge-m3 + tabla `fragmentos`). Un archivo
coincide si **todas** las palabras de la consulta aparecen, sin distinguir mayúsculas ni
tildes y también a medias ("presu" → "Presupuesto"), en su nombre, descripción manual o texto
extraído (`unaccent(...) ILIKE`). Primero los que casan por nombre, luego por fecha. Devuelve
un trozo del contenido alrededor de la coincidencia. `/api/archivos/buscar` busca solo lo
personal; `/api/compartido/:id/buscar`, solo esa carpeta compartida.

---

## Facturas — clasificación venta/compra, emisor/cliente y CIF (`facturas.service.ts`)

El sistema cataloga **ventas** (la empresa del propietario es el emisor) y **compras** (es el cliente). El modelo pequeño confunde emisor↔cliente sistemáticamente —en muchas facturas el emisor va en el **logo/membrete** (imagen) y el único nombre en la capa de texto es el del cliente—, así que la clasificación NO se delega en el prompt: es determinista, en `escanearFactura`, tras la extracción IA. Todo probado en `backend/tests/facturas.heuristicas.test.ts` (puros, sin BD/IA), con las 6 facturas reales del set (TRAZA, Repsol, Tesys, DonDominio, iFastNet, Xfera).

**1. Extracción**: el prompt + `SCHEMA_FACTURA` piden además `emisorNif`/`clienteNif` (forzar dos NIF distintos ya reduce el swap). El schema no marca nada `required` (ver "No inventar facturas").

**2. `reconciliarPartes(datos, contenido)`** — corrige emisor/cliente anclando en la **línea legal del pie**:
- `emisorPorRegistroMercantil`: busca un nombre con sufijo societario (`S.L.U.`, `S.A.`…) en la ventana ANTES de "…(inscrita en el) Registro Mercantil…" y el NIF justo DESPUÉS ("… NIF B39540760"). La regex acepta **catalán "Registre"** y **gallego "Rexistro"** (`re[gx]istr[eo]`) — sin esto, la factura de la luz de Repsol (en catalán) no anclaba y salía con emisor = AKX (el cliente).
- Reglas conservadoras (solo actúan si hay conflicto claro, nunca rompen una extracción ya coherente):
  - emisor del modelo == empresa del registro → ya correcto, no toca.
  - **cliente** del modelo == empresa del registro → **invertidos** → swap de nombre y NIF (caso TRAZA: el modelo puso el emisor real como cliente).
  - emisor ausente, o emisor≈cliente (duplicado, típico factura de la luz) → fija emisor+NIF con los del registro. `compartenTokenDistintivo` tolera ruido OCR del logo ("AKX Studio" vs "ARX Studio" comparten "studio").

**3. `resolverDireccion(datos, empresa, contenido)`** → `venta`|`compra`|`desconocido`:
- degenerado `emisor==cliente` → `desconocido` (no se puede decidir; queda fuera de ambas analíticas en vez de contar como venta falsa).
- por **CIF** de la empresa si se conoce: `emisorNif==empresa.nif`→venta; `clienteNif==empresa.nif`→compra.
- **ancla CIF-en-texto**: si `empresa.nif` aparece en el **texto** del documento (aunque el modelo no lo capturara en el campo cliente, p. ej. porque el OCR destrozó el nombre del cliente) y el emisor es OTRA empresa → compra.
- por **parecido de nombre** contra `empresa.nombre` (sin CIF): casa exactamente un lado → ese es el tenant. `normalizarNombreEmpresa` quita tildes/sufijos y unifica "estudio↔studio"; `mismaEmpresa` compara por solape de tokens significativos.

**4. Auto-CIF por corroboración** (`intentarAprenderCifEmpresa`, tras guardar): cuenta el NIF del lado del tenant (clienteNif en compras, emisorNif en ventas) entre las facturas de la empresa y **fija `empresa.nif` cuando uno se repite en ≥2** (`MIN_CORROBORACION_CIF`). Un primer intento aprendía del **primer** sample, y una factura con un NIF mal leído en la cabecera (TRAZA traía `B18861930` en vez del real `B13861935`) lo envenenaba; la corroboración deja ganar al bueno por repetición y hace innecesario descartar los swaps. El nombre de empresa varía demasiado entre facturas para anclar ("AKX STUDIO, S.L." / "AKX Studio SLU" / "AKX ESTUDIO S.L."); el CIF no. Editable por el admin en `/api/equipo/empresa` y por el superadmin en `/api/plataforma`.

**Analítica separada por `tipo`**: `construirFiltro` admite `tipo`; las funciones de ventas (`ventas_top`/`clientes_top`/`totales_facturado`) fijan `tipo='venta'` por defecto y las de compras (`compras_top` = `ventasTop` con tipo compra, `proveedoresTop` = ranking por `emisor`, `totales_compras`) `tipo='compra'`. Las `desconocido` quedan fuera de las dos.

**Resúmenes derivados, sin carpeta oculta** (cambio respecto al diseño anterior): los resúmenes agregados de ventas/compras **ya no** se materializan como archivos `resumen-ventas.md`/`resumen-compras.md` en una carpeta `/facturas`. Eran datos derivados de la BD que arrastraban mucha complejidad accidental (seguir la carpeta si el usuario la movía, colas de serialización para no pisar el `.md`, dedup/soft-delete/RAG de esos ficheros, y tener que ocultar la carpeta en cada listado). Ahora se calculan **al vuelo desde la BD** (página Facturas y consultas SQL del chat). Tampoco existen ya los `resumen-<archivo>.md` por factura (el markdown por factura sigue disponible como valor de retorno de `escanearFactura`, no como fichero). La migración `1776…-LimpiarResumenesFacturas` borra los `.md` y la carpeta `/facturas` que quedaran de la etapa anterior (los binarios MinIO quedan huérfanos, inofensivos). 

**Rescate del membrete solo si hace falta** (`extraerTexto`, rama PDF): el OCR de la 1ª página existe para leer el emisor cuando va como imagen (TRAZA). Pero si la capa de texto YA trae "…Registro/Registre Mercantil…" (`tieneRegistroMercantil`), el emisor ya está en el texto y el OCR solo METE RUIDO (visto: el logo "AKX" leído como "ARX" desviaba la clasificación) — así que en ese caso NO se rasteriza. Repsol (texto completo, catalán) se salta el OCR y sale limpia; TRAZA (emisor solo en la imagen del pie) sí lo dispara.

**Edición manual** (`GET`/`PATCH /api/facturas/:id`, página Facturas): el modelo pequeño siempre falla algún campo; la edición es la red de seguridad. `actualizarFactura` parchea cabecera (con `normalizarFecha`/`normalizarMoneda`) y reemplaza las líneas enteras (borrar+insertar, para no dejar huérfanas); la corrección se refleja sola en los resúmenes, que se generan al vuelo desde la BD (ya no hay `.md` que regenerar). La pestaña "Sin clasificar" (filtro `tipo=desconocido`) lista las que hay que rescatar.

**Reclasificar** (`POST /api/facturas/reclasificar`, botón "↻ Reclasificar"): el `tipo` se calcula y **guarda al escanear**, así que fijar/corregir el CIF de la empresa DESPUÉS no reclasifica lo ya escaneado — se quedaría todo en `desconocido`. `reclasificarFacturas` re-ejecuta `resolverDireccion` sobre los datos YA guardados (emisor/cliente/NIFs + el `textoExtraido` del archivo para el ancla CIF-en-texto), **sin re-escanear ni re-OCR** (instantáneo) y aprende el CIF por corroboración si aún no lo tiene (los resúmenes, al generarse desde la BD, ya reflejan el nuevo `tipo`). Caso típico: empresa creada sin CIF → todas `desconocido` → el admin pone su CIF en Equipo → "Reclasificar".

## OCR y descripción de imágenes (`extraccion.service.ts`) — cascada de 3 pasadas

`ocrImagen()` usa una cascada "ligero primero" (los dos primeros son modelos Ollama configurables; el tercero es CPU pura):

1. **Normalización a PNG** (`aPng`, sharp): TODA imagen se reconvierte a PNG antes de mandarla a Ollama. Sin esto, **WEBP** hacía fallar la decodificación en llama.cpp (y en GPU llegaba a tirar el proceso de Ollama).
2. **1ª pasada — granite3.2-vision** (`OLLAMA_CAPTION_MODEL`): VLM ligero (~2.4GB). Transcribe el texto si lo hay o describe la foto si no, en una sola llamada. El prompt fuerza descripción **siempre en español**.
3. **¿Parece factura con importes?** (`pareceFacturaConImportes`): símbolos de moneda / palabras clave (factura, IVA, total…) o muchos dígitos → escala a la 2ª pasada. Si no, se queda con granite (sin pagar la pasada lenta).
4. **2ª pasada — deepseek-ocr** (`OLLAMA_OCR_MODEL`): OCR especialista, la transcripción más fiel de tablas/importes. Solo para lo que parece factura. Si falla/alucina, se conserva granite. Su salida puede traer tablas HTML; `limpiarTablasHtml()` las pasa a texto plano con `|`, consistente con pdf-parse.
5. **¿Resultado pobre?** (`pareceResultadoPobre`): vacío, "meta-descripción" (habla SOBRE la estructura citando NOMBRES de campos en vez de valores) o negación de texto ("no hay texto...") sin nada útil detrás (<15 palabras) → 3ª red. Cuidado con falsos positivos: una descripción real puede empezar "La imagen presenta..." o terminar "No hay texto presente en la imagen"; por eso la meta-descripción se caza por frases concretas y la negación solo cuenta si el resto es corto.
6. **3ª red — Tesseract.js** (`ocrConTesseract`, worker singleton `createWorker(IDIOMAS_OCR)` con `IDIOMAS_OCR = "spa+cat+eng"` — castellano primero + catalán e inglés, para facturas escaneadas/fotos en esas lenguas; los `.traineddata` van vendorizados en `backend/tessdata/` y los copia el Dockerfile): OCR clásico por CPU, sin alucinaciones. Preprocesado (`prepararParaTesseract`: gris + normalización + reescalado a ancho mínimo 2000px) y **dos pasadas** (`PSM.AUTO` + `PSM.SPARSE_TEXT`) concatenadas: en pruebas reales `AUTO` se saltaba filas de tablas con bordes y `SPARSE_TEXT` las recuperaba pero perdía precisión en otros datos; ningún modo gana siempre, así que se quedan los dos y la IA de extracción escoge el dato correcto.
7. **Español garantizado** (`asegurarEspanol`/`pareceIngles`/`traducirAlEspanol`): si el resultado tiene 2+ palabras inglesas típicas, se traduce con `OLLAMA_MODEL` antes de guardar.

Si `OLLAMA_OCR_MODEL == OLLAMA_CAPTION_MODEL`, la 2ª pasada se desactiva sola (máquinas con un solo VLM). Reparto: granite clasifica/describe barato, deepseek afina facturas, Tesseract entra solo cuando ningún VLM dio algo aprovechable. (Se comprobó que ningún modelo pequeño iguala a deepseek en fidelidad de OCR, y que deepseek alucina ante fotos sin texto.)

`pareceBucleDegenerado()` descarta la basura de un modelo solo-OCR ante imagen sin texto (bucle repitiendo `<table:tr><td>…` o `None`). Juzga el contenido **tras quitar el HTML**, y la regla "menos de 3 palabras → basura" solo se aplica si el texto original TENÍA etiquetas (deepseek emite esas etiquetas también para tablas legítimas; una respuesta corta SIN etiquetas es pobre por otra razón).

En GPU de 8GB, deepseek-ocr (6.7GB) no entra entero (corre parcial en CPU, ~2 min/imagen) — pero solo se invoca en imágenes que parecen factura. Todo en segundo plano.

### Describir una imagen a mano (`PATCH /api/archivos/:id/descripcion`)
Ya **no** hay modal obligatorio al subir. Con la cascada, una foto sin texto se describe automáticamente al subir. El endpoint queda para corregir/afinar a mano; lo que se guarde se combina con el OCR vía `combinarContenido` (que omite repetir el OCR si ya está contenido en la descripción) y lo leen el chat y el buscador. Escanear manualmente algo que no es factura ya no copia `textoExtraido` dentro de `descripcionManual` (solo guarda la pista real del usuario).

### No inventar facturas a partir de imágenes que no lo son
El `SCHEMA_FACTURA` ya NO marca campos como `required`: con la decodificación restringida de Ollama, exigir todos los campos forzaba al modelo a inventar emisor/cliente/importes cuando el texto era una foto sin factura. Además, antes de extraer hay un **gate** `pareceFacturaConImportes(contenido)`: si el contenido no tiene señales de factura, no se llama a la IA y se trata como `no_factura`. Y al detectar `no_factura` se borra cualquier factura inventada que se hubiera guardado antes para ese archivo.

**Importes inventados en una factura que SÍ es factura pero trae los importes en blanco** (caso real: una factura de *devolución de equipo sin reparar* con base/IVA/total vacíos — solo el símbolo `€` sin número): el gate deja pasar (tiene "FACTURA"/"IVA"/"base imponible") y el modelo, al pedírsele rellenar todos los campos, se saca de la nada base/IVA/total. `verificarImportesReales(datos, contenido)` (en `facturas.service.ts`, justo antes de la guarda `tieneImportes`) **vacía a 0 todo importe que no aparezca EN CONTEXTO MONETARIO en el texto** del documento (`numerosMonetariosDelTexto`). Un número solo cuenta como importe si (a) trae céntimos explícitos —exactamente 2 decimales— (`141,60`, `2.025,00`, `50.00`) o (b) va pegado a un símbolo/nombre de moneda (`€ 120`, `120€`, `120 EUR`). **No** vale cualquier número: un nº de RMA (`RMA: 2.025/SAT/542`), un NIF, un código de cliente o una fecha no son importes — el primer intento (aceptar cualquier número) dejó colar un total inventado `2.025,00 €` que coincidía con el RMA `2.025`; el `(?!\d)` de la regla (a) descarta ese `2.025` (3 dígitos tras el punto = miles) y la cantidad `1,0000`. `interpretacionesNumericas` genera todas las lecturas de cada token (miles ES/EN y último separador como decimal) para no descartar un importe correcto por formato. Efecto: sin importes legibles, la guarda la trata como `no_factura` en vez de guardar cifras falsas. Trade-off asumido: una factura legítima de importe **0** tampoco se guarda en la analítica (mejor que inventar).

---

## Auto-escaneo de facturas al subir

Al subir PDF/imagen, tras extraer el texto, `ctrlSubir` encola una tarea durable `autoescanear` (`tareas.service.ts`) que se procesa en segundo plano:
1. Si es PDF/imagen, se escanea con `escanearFactura(..., { soloSiFactura: true })`.
2. Guardia: solo persiste la factura si la extracción parece factura (líneas o importes > 0).

Para facturas subidas antes de esta función: escanearlas desde la página Facturas / el explorador (el chat ya no escanea: es de solo lectura).

---

## Limitaciones conocidas (detalle)

- **Modelo del chat**: el text-to-SQL depende del tamaño del modelo. `qwen3:14b` (cabe entero en 12 GB con `OLLAMA_NUM_CTX=8192`, sin tocar la configuración de Ollama) es el objetivo; con 3b/7b el SQL falla bastante más (columnas inventadas, sumas mezclando monedas). Los errores de Postgres se le devuelven para que corrija, pero con un modelo pequeño no siempre lo consigue. La extracción de facturas con un modelo pequeño también mezcla campos (p. ej. nombre+email+teléfono en `cliente`).
- **VRAM compartida**: chat (qwen3:14b ~9 GB) y OCR (granite ~2,4 GB, deepseek-ocr ~6,7 GB) no caben a la vez en 12 GB; Ollama los intercambia y la primera respuesta del chat tras un escaneo tarda unos segundos más.
- **PDFs escaneados (sin capa de texto)**: `pdf-parse` no hace OCR; solo las imágenes pasan por la cascada de visión. Para un PDF puramente escaneado habría que rasterizar las páginas a imagen antes del OCR (pendiente).
- **Auto-escaneo al subir**: consume cómputo de OCR+IA por cada PDF/imagen, aunque la guardia `soloSiFactura` no guarde los que no son factura.
- **GPU pequeña (8GB)**: deepseek-ocr corre parcial en CPU (~2 min/imagen); no bloquea la subida (segundo plano). Tesseract siempre en CPU.
