# CloudDrive — Backend (API + servicios)

Mini-OneDrive con chatbot IA: los archivos viven en MinIO, la metadata en Postgres,
un asistente (Ollama) responde preguntas sobre los archivos y las facturas consultando
la base de datos con SQL de solo lectura, y se puede buscar por nombre y por el
**contenido** de los documentos.

## Stack

| Parte | Tecnología |
|---|---|
| Servidor HTTP / rutas | Express 5 + TypeScript (ts-node en dev, `tsc` en build) |
| ORM / base de datos | TypeORM + PostgreSQL 16 (imagen **pgvector**) |
| Almacenamiento de archivos | **MinIO** (S3-compatible), descarga por streaming desde la API |
| IA / asistente | **Ollama**: chat `qwen3:14b` (escribe SQL de solo lectura) + visión `granite3.2-vision` (rápido) → `deepseek-ocr` (OCR fiel de facturas) → **Tesseract.js** (red de seguridad por CPU si los dos modelos anteriores se quedan cortos) |
| Extracción de texto | `pdf-parse` (PDF) + `mammoth` (Word) + texto plano; imágenes: cascada de 3 pasadas — granite transcribe/describe, si parece factura deepseek-ocr re-lee para no fallar dígitos, y si ninguno de los dos da algo aprovechable entra Tesseract.js (OCR clásico, preprocesado con sharp). Se puede añadir una descripción a mano (`PATCH .../descripcion`) |
| Subida de ficheros | Multer (en memoria, filtro MIME, límite 50 MB) |
| Auth | JWT (`jsonwebtoken`) + bcrypt |
| Validación | Zod (entrada y variables de entorno) |
| Seguridad HTTP | Helmet, CORS, `express-rate-limit` |
| Orquestación | Docker Compose |

## Arquitectura y flujo

```
[Angular] → [API Express] → [Postgres: metadata + texto extraído]
                         ↘ [MinIO: binarios de archivos]
                         ↘ [Ollama: chat (SQL) + visión/OCR]
```

Flujo de una petición: **ruta → middleware (auth JWT, validación) → controller → service → Postgres/MinIO**.
La IA solo LEE la BD, a través de vistas filtradas por usuario y un rol de Postgres de
solo lectura; todo lo que modifica pasa por la API normal.

## Arranque

```bash
cp .env.example .env         # rellenar contraseñas y JWT_SECRET (mín. 16 chars)
docker compose up -d         # db + minio + api + web + ollama (en casa, vía override)
docker exec clouddrive-ollama ollama pull qwen3:14b          # chatbot + extracción de facturas
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
no se vuelve a subir ni a reprocesar (OCR) — se reutiliza el existente y se
avisa, evitando además duplicar facturas en la analítica.

### Carpetas
Rutas virtuales tipo `/facturas/2026` (solo metadata, sin carpetas reales). Operaciones
de borrar/vaciar/mover/copiar comprueban que la carpeta **origen exista** antes de actuar
(si no, devuelven 404 en vez de fingir éxito y crear el destino vacío). `vaciar_carpeta`
acepta `/` como ruta especial para vaciar solo los archivos sueltos en la raíz, sin tocar
el contenido de las carpetas.

### Chatbot (`services/chat.service.ts`)
El asistente **lee la base de datos escribiendo SQL de solo lectura**; no hay *tool
calling* ni detección de intenciones por regex. Por cada mensaje:

1. El modelo (`qwen3:14b`, `OLLAMA_MODEL`) recibe el esquema de unas **vistas de solo
   lectura** (`chat.archivos`, `chat.carpetas`, `chat.carpetas_compartidas`,
   `chat.facturas`, `chat.lineas_factura`), la fecha de hoy, reglas y ejemplos, más los
   últimos 8 mensajes de la conversación.
2. Si necesita datos, responde con un bloque ```` ```sql ````. La API lo ejecuta y le
   devuelve las filas (o el error de Postgres para que corrija). Hasta 4 consultas por
   mensaje.
3. Con los datos, redacta la respuesta en markdown. Si el resultado tiene varias filas,
   la API lo devuelve también como `tabla` y el front la pinta debajo (con botón "Abrir"
   en los archivos).

**Solo consulta**: mover, copiar, borrar, subir o restaurar se hace desde el explorador.

**Seguridad**: el SQL corre con un rol de Postgres propio (`ateka_chat`) que solo puede
leer esas vistas, y cada vista solo devuelve filas del usuario de la petición (token de
un solo uso que el rol no puede leer). Una sola sentencia, transacción de solo lectura,
tiempo máximo de 10 s y 200 filas. Detalle en `NOTAS.md`.

#### Qué puede pedirle el usuario al chatbot
Cualquier pregunta sobre sus datos: "¿qué archivos tengo en /proyectos?", "¿qué subí
esta semana?", "¿qué documento habla de la garantía?", "¿cuánto he facturado este
trimestre?", "mis 5 mejores clientes", "¿cuánto IVA tengo que pagar en el Q2?",
"¿vendí más en abril o en mayo?". Lo que puede ver depende del rol: `facturas` (datos de
facturas) y `busqueda` (contenido de los documentos).

### Buscador del explorador (`services/contenido.service.ts`)
Búsqueda normal, sin IA: un archivo sale si **todas** las palabras buscadas aparecen
(sin distinguir mayúsculas ni tildes, también a medias) en su nombre o en su contenido
(texto extraído de PDF/Word/OCR + descripción manual). Primero los que coinciden por
nombre; cada resultado muestra el trozo del documento donde aparece.

### Procesado en segundo plano: cola durable (`services/tareas.service.ts`)
El trabajo pesado de una subida (extraer texto, auto-escanear
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
  entities/     Usuario, Archivo, Carpeta, Factura, LineaFactura, Tarea (cola durable)
  migrations/   InitialSchema → AddPerfilUsuario → CrearCarpetas → AgregarRagFragmentos →
                 MigrarEmbeddingMultilingue → AgregarFacturas → HabilitarUnaccent →
                 AgregarEstadoEscaneo → AgregarDescripcionManual →
                 AgregarTareasYEstadoIndexado → AgregarChatPendientes → IndiceHashArchivos
  middlewares/  auth (JWT), validarUUID, errorHandler, limites (rate-limit + backlog)
  routes/       auth, archivos (+carpetas, +buscar), chat, facturas
  controllers/  auth, archivos, chat, facturas
  services/     auth, archivos, carpetas, chat (SQL de solo lectura), contenido (texto +
                 buscador), extraccion (texto/OCR), facturas,
                 tareas (worker de la cola durable), reconciliacion (mantenimiento)
docker-compose.yml          db + minio + api + web (frontend nginx)
docker-compose.override.yml ollama + adminer (solo en local)
```

## Endpoints (resumen)

- **Auth** (`/api/auth`): `POST /registro`, `POST /login`, `GET /perfil` 🔒, `PATCH /perfil` 🔒
- **Archivos** (`/api/archivos`) 🔒: `POST /subir`, `GET /` (paginado, `?carpeta=`),
  `GET /buscar?q=` (por nombre y contenido), `GET /:id`, `GET /:id/descargar` (streaming
  del binario a través de la API), `PATCH /:id`, `PATCH /:id/descripcion` (describir a
  mano una imagen sin texto legible), `DELETE /:id` (papelera),
  `DELETE /:id/permanente`; papelera: `GET /papelera`, `PATCH /:id/restaurar` (si ya
  hay un activo con el mismo nombre, le pone sufijo "(restaurado)"), `DELETE /papelera`
- **Carpetas** (`/api/archivos/carpetas`) 🔒: crear/listar/mover/eliminar
- **Chat** (`/api/chat`) 🔒: conversación con el asistente → `{respuesta, tabla?}`
- **Facturas** (`/api/facturas`) 🔒: `POST /escanear` (responde **202** y encola el
  escaneo en segundo plano — OCR + extracción de datos + **clasificación venta/compra**;
  el estado final se ve en la columna "Estado", y marca `no_factura` si no hay datos
  reales en vez de inventarlos), `GET /` (listado paginado y filtrable — `?tipo=venta|compra|desconocido`
  para las pestañas de la página Facturas),
  `GET /:id` (detalle con líneas), `PATCH /:id` (**edición manual**: corrige
  emisor/cliente/tipo/importes/líneas y regenera los resúmenes), `POST /reclasificar`
  (re-aplica venta/compra a lo ya escaneado con el CIF/nombre actual de la empresa,
  sin re-escanear — para cuando se fija el CIF después de escanear)
- `GET /health`: estado de la API y conexión a BD

## Tests

```bash
cd backend && npm test     # Jest + Supertest contra una BD de test aislada (clouddrive_test)
```

Requiere Postgres y MinIO levantados; la BD de test se crea sola (usa `synchronize`).
Cubren auth, archivos, deduplicación, cap de backlog, buscador, validación de avatar,
reconciliación/retención y la **frontera de seguridad del chat** (`chat.sql`: aislamiento
entre usuarios, sin escrituras ni acceso a las tablas reales); las **heurísticas de facturas** (`facturas.heuristicas`:
clasificación venta/compra, anclaje emisor/cliente por "Registro Mercantil", CIF,
idioma) se testean de forma pura (sin BD ni Ollama).

## Despliegue (servidor, acceso por IP, todo en Docker)

Monorepo: un único clon en el servidor (`backend/` y `frontend/` ya están dentro). El
servicio `web` del `docker-compose.yml` construye el frontend desde `./frontend`.

```bash
cp .env.example .env        # editar OLLAMA_URL al Ollama externo del servidor (con GPU)
rm docker-compose.override.yml   # en el servidor NO se usa Ollama en contenedor
docker compose up -d --build     # db + minio + api + web
docker exec <ollama-del-servidor> ollama pull qwen3:14b   # o el modelo que toque
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
- [x] **Fase 3 — RAG:** extracción de texto (PDF/Word/texto), embeddings (bge-m3 + pgvector), búsqueda híbrida (sustituida después por búsqueda de texto normal)
- [x] **Fase 4 — Facturas:** visión en cascada de 3 pasadas (granite3.2-vision → deepseek-ocr para facturas → Tesseract.js como red de seguridad por CPU), auto-escaneo al subir, analítica filtrable vía tools (`ventas_top`, `totales_facturas`, `clientes_top`), descripción de fotos a mano opcional
- [x] **Fase 5 — Robustez:** cola de trabajos durable en Postgres + worker (reintentos, backoff, sobrevive a reinicios) que sustituye al procesado en memoria, estado de indexado en el explorador, estado del chat fuera de memoria, deduplicación por hash al subir, rate-limit + cap de backlog en los endpoints caros, confirmación para vaciar la papelera, validación del avatar, reconciliación MinIO↔Postgres + retención de papelera, y detección de intenciones del chat extraída a un módulo puro con tests
- [x] **Fase 6 — Chat por SQL:** el asistente deja el *tool calling* y los pre-flights por regex y consulta la BD con SQL de solo lectura (rol `ateka_chat` + vistas filtradas por usuario); se quita la búsqueda semántica (bge-m3) y el buscador pasa a búsqueda de texto normal
