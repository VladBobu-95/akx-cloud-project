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
| IA / asistente | **Ollama**: chat `qwen2.5:7b` (*tool calling*) + embeddings `bge-m3` (RAG) |
| Extracción de texto | `pdf-parse` (PDF) + `mammoth` (Word) + texto plano |
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
copy .env.example .env       # rellenar contraseñas y JWT_SECRET (mín. 16 chars)
docker compose up -d         # db + minio + api + web + ollama (en casa, vía override)
docker exec clouddrive-ollama ollama pull qwen2.5:7b   # modelo del chatbot
docker exec clouddrive-ollama ollama pull bge-m3       # modelo de embeddings (búsqueda)
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
`MigrarEmbeddingMultilingue` (dimensión del vector a 1024 para bge-m3).

### Autenticación
Registro/login devuelven un JWT (7 días). Las contraseñas se guardan hasheadas con
bcrypt. El middleware `auth` protege las rutas y deja el `usuarioId` disponible para
que cada servicio filtre **solo los datos de ese usuario**. Rate limiting en login/registro.

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
de borrar/vaciar/mover comprueban que la carpeta **exista** antes de actuar (si no,
devuelven 404 en vez de fingir éxito).

### Chatbot (`services/chat.service.ts`)
Bucle de *tool calling* contra Ollama: el modelo recibe el mensaje + el catálogo de
herramientas, decide cuáles llamar, la API las ejecuta de verdad y devuelve el
resultado; se repite hasta que el modelo da la respuesta final. Las acciones reales se
acumulan y se devuelven al frontend (las "✓"). Medidas para que sea fiable en CPU:

- Modelo **`qwen2.5:7b`** (configurable con `OLLAMA_MODEL`; debe soportar tool calling).
- **`temperature: 0`** (determinista) y **`keep_alive: 30m`** (no recarga el modelo entre mensajes).
- El *system prompt* obliga a usar las herramientas, no inventar rutas y responder breve.
- Herramientas disponibles: buscar/crear/mover/renombrar/copiar/eliminar archivos y
  carpetas, papelera (listar/restaurar/borrar/vaciar), `leer_archivo`, `estadisticas`,
  **`borrar_todo`** (envía todo a la papelera y elimina las carpetas) y
  **`buscar_semantica`** (busca por el contenido de los documentos).

**Cambiar de modelo:** edita `OLLAMA_MODEL` en `.env`, haz
`docker exec clouddrive-ollama ollama pull <modelo>` y `docker compose up -d api`.

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
  entities/     Usuario, Archivo, Carpeta
  migrations/   InitialSchema → AddPerfilUsuario → CrearCarpetas → AgregarRagFragmentos → MigrarEmbeddingMultilingue
  middlewares/  auth (JWT), validarUUID, errorHandler
  routes/       auth, archivos (+carpetas, +buscar), chat
  controllers/  auth, archivos, chat
  services/     auth, archivos, carpetas, chat, extraccion (texto), rag (embeddings/búsqueda)
docker-compose.yml          db + minio + api + web (frontend nginx)
docker-compose.override.yml ollama + adminer (solo en local)
```

## Endpoints (resumen)

- **Auth** (`/api/auth`): `POST /registro`, `POST /login`, `GET /perfil` 🔒, `PATCH /perfil` 🔒
- **Archivos** (`/api/archivos`) 🔒: `POST /subir`, `GET /` (paginado, `?carpeta=`),
  `GET /buscar?q=` (búsqueda semántica/RAG), `GET /:id`, `GET /:id/descargar`,
  `PATCH /:id`, `DELETE /:id` (papelera), `DELETE /:id/permanente`;
  papelera: `GET /papelera`, `PATCH /:id/restaurar`, `DELETE /papelera`
- **Carpetas** (`/api/archivos/carpetas`) 🔒: crear/listar/mover/eliminar
- **Chat** (`/api/chat`) 🔒: conversación con el asistente
- `GET /health`: estado de la API y conexión a BD

## Tests

```bash
cd backend && npm test     # Jest + Supertest contra una BD de test aislada (clouddrive_test)
```

Requiere Postgres y MinIO levantados; la BD de test se crea sola (usa `synchronize`).

## Despliegue (servidor, acceso por IP, todo en Docker)

Requiere clonar **los dos repos uno al lado del otro** (`cloud-project` y
`akx-cloud-frontend`), porque el servicio `web` se construye desde `../akx-cloud-frontend`.

```bash
cp .env.example .env        # editar OLLAMA_URL al Ollama existente del servidor
docker compose -f docker-compose.yml up -d --build   # db + minio + api + web (sin override)
docker exec clouddrive-ollama ollama pull qwen2.5:7b   # o usar el Ollama del servidor
docker exec clouddrive-ollama ollama pull bge-m3
```

El servicio `web` (nginx) sirve el frontend en el **puerto 80** y hace de proxy de
`/api` hacia la API (mismo origen, sin CORS). Abrir solo el 80 (y el 3000 si se quiere la
API directa); no exponer 5433 (Postgres) ni 9000 (MinIO).

## Fases

- [x] **Fase 1 — Drive básico:** auth JWT, subir/descargar/listar/carpetas, papelera, tests
- [x] **Fase 2 — Chatbot:** Ollama + tool calling sobre archivos y carpetas
- [x] **Fase 3 — RAG:** extracción de texto (PDF/Word/texto), embeddings (bge-m3 + pgvector), búsqueda híbrida
- [ ] **Fase 4 — Facturas:** visión/OCR, analítica vía tools
