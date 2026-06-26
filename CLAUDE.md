# AKX Cloud — Monorepo (akx-cloud-project)

App de almacenamiento en la nube con chatbot IA. Backend Node/TypeScript + frontend Angular 22.

**Repo:** `https://github.com/VladBobu-95/akx-cloud-project`

> El **detalle y el porqué** de cada decisión (pre-flights del chat, cascada OCR, RAG,
> historial de bugs, limitaciones) está en **`NOTAS.md`** — que NO se carga cada sesión.
> Este `CLAUDE.md` es la referencia compacta de uso frecuente; consulta `NOTAS.md` cuando
> toques chat/OCR/RAG en profundidad.

```
akx-cloud-project/
  backend/                    ← API REST (Express + TypeORM + pgvector + MinIO + Ollama)
  frontend/                   ← SPA Angular 22
  docker-compose.yml          ← Producción: db, minio, api, web
  docker-compose.override.yml ← Solo local: añade ollama y adminer
  .env                        ← Secretos (no commitear, ver .env.example)
  CLAUDE.md / NOTAS.md
```

---

## Stack

| Capa | Tecnología |
|---|---|
| API | Node 22, Express 5, TypeScript 6 |
| ORM | TypeORM + PostgreSQL 16 + pgvector |
| Objetos | MinIO (S3-compatible) |
| IA chat | Ollama — `qwen2.5-coder:14b` (servidor con GPU); `qwen2.5-coder:7b`/`3b` en máquinas pequeñas |
| IA embeddings | Ollama — `bge-m3` (1024 dims) |
| Visión/OCR | Cascada granite3.2-vision → deepseek-ocr → Tesseract.js (ver `NOTAS.md`) |
| Extracción | pdf-parse v2 (PDF), mammoth (DOCX) |
| Auth / Validación | JWT + bcrypt / Zod |
| Frontend | Angular 22 (signals, standalone), SCSS, marked v18 |

---

## Arrancar

### Stack completo en Docker
```bash
cp .env.example .env                          # rellenar valores reales
docker compose up -d
# modelos Ollama (solo 1ª vez):
docker exec clouddrive-ollama ollama pull qwen2.5-coder:14b   # o :7b/3b
docker exec clouddrive-ollama ollama pull bge-m3
docker exec clouddrive-ollama ollama pull deepseek-ocr
docker exec clouddrive-ollama ollama pull granite3.2-vision
```

| URL | Servicio |
|---|---|
| `http://localhost` | Frontend (nginx) |
| `http://localhost:3000` | API |
| `http://localhost:8080` | Adminer |
| `http://localhost:9001` | MinIO Console |

### Dev loop (rápido, sin rebuilds) — recomendado para desarrollar
```bash
docker compose up -d db minio ollama adminer   # solo infraestructura
docker compose stop api web                     # liberar puertos 3000 y 80
cd backend && npm run dev                        # nodemon+ts-node → localhost:3000, recarga al guardar
cd frontend && npm start                         # ng serve → localhost:4200 (proxy /api → :3000)
```
Editas `.ts`/`.html`/`.scss` y ves el cambio al instante, sin tocar contenedores. Para
desplegar al final: `docker compose build api web && docker compose up -d api web`.

---

## Variables de entorno (.env)
```env
DB_USER, DB_PASSWORD, DB_NAME, DB_PORT_HOST=5433
MINIO_USER, MINIO_PASSWORD, MINIO_BUCKET=archivos, MINIO_PORT_HOST=9000, MINIO_CONSOLE_HOST=9001
API_PORT_HOST=3000, JWT_SECRET=<min 32 chars>, CORS_ORIGIN=*   # en prod: dominio del front
OLLAMA_URL=http://host.docker.internal:11434                   # local override → http://ollama:11434
OLLAMA_MODEL=qwen2.5-coder:14b                                 # chat (7b/3b en máquinas pequeñas)
OLLAMA_EMBED_MODEL=bge-m3
OLLAMA_CAPTION_MODEL=granite3.2-vision                         # 1ª pasada visión
OLLAMA_OCR_MODEL=deepseek-ocr                                  # 2ª pasada (solo si parece factura)
```
`env.ts` valida con Zod y **falla al arrancar** si falta algo. Cambiar de modelo: editar
`.env` + `docker compose up -d api` (recarga .env, sin rebuild).

## Docker Compose
```bash
docker compose build api && docker compose up -d api   # cambios de CÓDIGO backend
docker compose up -d api                                # cambios de .env (sin rebuild)
docker compose build web && docker compose up -d web    # frontend
docker compose logs -f api
```
`restart` NO recarga .env ni código (solo reinicia). Código → `build` + `up -d`; .env → `up -d`.

---

## Estructura backend (`backend/src/`)
```
config/      database.ts (TypeORM+pgvector), env.ts (Zod), minio.ts
controllers/ entrada HTTP, delegan en services
entities/    Archivo, Carpeta, Factura, LineaFactura, Usuario
middlewares/ auth (JWT→req.usuario), errorHandler (AppError→JSON)
migrations/  TypeORM, se ejecutan al arrancar
services/
  archivos.service.ts    CRUD, papelera, carpetas zip, leerTextoArchivo (RAG)
  auth.service.ts        registro/login JWT
  carpetas.service.ts    mover/copiar/vaciar/borrar con contenido
  chat.service.ts        chatbot IA (ver abajo + NOTAS.md)
  extraccion.service.ts  texto de PDF/DOCX/txt + cascada OCR de imágenes
  facturas.service.ts    escaneo, auto-escaneo, analítica filtrable, listados paginados
  rag.service.ts         embeddings bge-m3, indexación, búsqueda semántica
```

---

## API Routes
Todas requieren `Authorization: Bearer <token>` salvo `/api/auth/*`.

### `/api/auth`
| Método | Ruta | Body |
|---|---|---|
| POST | `/registro` | `{email, password, nombre}` (máx 5/h por IP en prod) |
| POST | `/login` | `{email, password}` → `{usuario, token}` (máx 10/15min en prod) |
| GET/PATCH | `/perfil` 🔒 | PATCH `{nombre?, avatar?, password?}` — avatar = data URL base64 (`""` quita) |

### `/api/archivos`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/subir` | multipart: `archivo` + `carpeta` opcional |
| GET | `/` | query `carpeta`, `pagina`, `limite` → body = `Archivo[]`, totales en headers `X-Total-Count`/`X-Total-Pages`/`X-Current-Page` |
| GET | `/buscar` | búsqueda semántica RAG — query `q` |
| GET/DELETE | `/papelera` | listar / vaciar |
| GET | `/carpeta/descargar` | .zip — query `ruta` |
| GET/POST/PATCH/DELETE | `/carpetas` | listar / crear `{ruta}` / mover `{origen,destino}` / borrar `?ruta=` |
| GET | `/:id` | metadata (sin binario) |
| PATCH | `/:id` | `{nombre?, carpeta?}` |
| POST | `/:id/copiar` | `{carpeta?, nombre?}` |
| PATCH | `/:id/restaurar` | de papelera (sufijo "(restaurado)" si colisiona) |
| PATCH | `/:id/descripcion` | `{descripcion}` — describe imagen a mano, se reindexa (RAG) |
| GET | `/:id/descargar` | streaming del binario por la API |
| DELETE | `/:id` / `/:id/permanente` | soft delete / borrado definitivo |

### `/api/chat`
| Método | Ruta | Body / Respuesta |
|---|---|---|
| POST | `/` | `{mensajes: [{rol, contenido}]}` → `{respuesta, acciones[], archivos?, tablaFacturas?, tablaArchivos?, tablaCarpetas?}` |

`archivos` = `{id,nombre}[]` cuando la respuesta resolvió archivos concretos (front muestra botón "Abrir"). Las `tabla*` son listados paginados (ver `NOTAS.md` › paginación).

### `/api/facturas`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/escanear` | `{archivoId, pista?}` — **asíncrono** (202): valida, marca `pendiente`, encola en background; resultado vía polling de la columna "Estado" |
| GET | `/` | listado paginado — query `cliente`/`emisor`/`carpeta`/`desde`/`hasta`/`facturas`/`papelera`/`pagina`/`limite` → `{filas, total, paginas}`. Lo usa la paginación de tablas del chat |

---

## Schema de BD
- **usuarios**: `id`, `email` unique, `nombre`, `avatar` (base64, null), `passwordHash`, `rol` (`user`|`admin`, default `user`; el registro ignora `rol` del cliente), `creadoEn`.
- **archivos**: `id`, `nombre`, `carpeta` (ruta), `mimeType`, `tamanoBytes`, `claveMinio`, `hashSha256`, `textoExtraido` (RAG, ~20k chars), `descripcionManual`, `estadoEscaneo`, `eliminadoEn` (soft delete), `propietario` CASCADE.
- **carpetas**: `id`, `ruta` (unique por propietario), `creadoEn`.
- **facturas**: `propietario`, `archivo` (nullable, CASCADE), `numero`, `fecha`, `emisor`, `cliente`, `subtotal`/`iva`/`total` numeric(12,2), `lineas` cascade.
- **lineas_factura**: `descripcion`, `cantidad`, `precioUnit`, `total`.
- **fragmentos** (RAG): `archivoId`, `propietarioId`, `indice`, `texto`, `embedding vector(1024)`.

---

## Chat (`chat.service.ts`) — resumen
1. **Solo el último mensaje del usuario** se envía al modelo (reenviar el historial hacía que modelos pequeños re-ejecutaran acciones, p. ej. repetir `borrar_todo`).
2. **Pre-flights deterministas por regex**: las frases comunes (borrados masivos, listados, abrir/leer, facturas por periodo/cliente, analítica, crear nota, restaurar vs. borrar...) se resuelven directo contra la BD sin llamar a Ollama. **Lista completa y rationale en `NOTAS.md`.**
3. **Bucle de tools** (máx 15, temp 0): con parser de respaldo (tool calls como texto JSON), remapeo de nombres alucinados, resolución flexible de nombres, y **bypass de resumen** (si las tools devuelven `resumen`, se retorna ese markdown sin re-llamar al modelo). Detalle en `NOTAS.md`.
4. **Listados paginados** (`tablaFacturas`/`tablaArchivos`/`tablaCarpetas`): ver `NOTAS.md`.

**Tools:** buscar/copiar/mover/renombrar/eliminar/crear archivo, crear/listar/eliminar/vaciar/mover/renombrar/copiar carpeta, borrar_todo/_todas_carpetas/_todos_archivos, listar_papelera, restaurar_archivo/_todo, borrar_permanente, vaciar_papelera, leer_archivo, estadisticas, buscar_semantica, escanear_factura/_todas, obtener_factura, ventas_top, totales_facturas, clientes_top.

## OCR y RAG — resumen
- **OCR imágenes** (`extraccion.service.ts`): cascada de 3 pasadas (granite → deepseek si parece factura → Tesseract si los VLM se quedan cortos), normalizando a PNG primero. Detalle completo en `NOTAS.md`.
- **RAG** (`rag.service.ts`): al subir → extrae texto → chunks de **1000 chars / solape 150** → embeddings **bge-m3 (1024)** → tabla `fragmentos`. Búsqueda híbrida (coseno `<=>` OR `ILIKE`), `MIN_SCORE = 0.50`, un fragmento por archivo.
- **Auto-escaneo de facturas al subir**: `ctrlSubir` dispara `autoEscanearArchivo` en background; solo persiste si parece factura (`soloSiFactura`).

---

## Estructura frontend (`frontend/src/app/`)
```
core/    archivos/auth/chat/theme/toast .service.ts, auth.guard, auth.interceptor (JWT), models.ts
layout/  shell (navbar)
pages/   login, inicio (chat), archivos (explorador), papelera, perfil   [cada uno .ts/.html/.scss]
shared/  file-size.pipe, toasts.component, errores.ts (mensajeError)
app.routes.ts, app.config.ts (provideRouter + HttpClient con interceptor), styles.scss (tema)
```
- **Estado con signals** (sin NgRx). Standalone components. Markdown del bot con `marked` (`breaks: true`).
- **archivos.ts**: árbol de carpetas en cliente (carga todos los archivos), drag&drop con eventos `pointer`, menú contextual, selección múltiple, columna "Estado" (polling 3s), paginación en cliente.
- **chat**: historial en signal + localStorage (`akx_chat`); se resetea al cambiar de sesión (`ChatService.reset()` desde `AuthService`) para no filtrarse entre usuarios.
- **Tema** (`styles.scss`): `--green #16a34a`, `--green-dark`, `--green-soft`, `--bg/--surface/--text/--muted/--border/--danger`, `--radius 12px`. Modo oscuro: `body.dark`.

---

## Despliegue (servidor)
- `git pull` → `docker compose build api web && docker compose up -d api web`.
- En el servidor se **borra `docker-compose.override.yml`** (Ollama externo con GPU vía `OLLAMA_URL=http://host.docker.internal:11434` + `extra_hosts`).
- API detrás de nginx (servicio `web`): `app.set("trust proxy", 1)` para que `express-rate-limit` lea bien la IP.
- Puertos del host configurables por `.env` (`WEB_PORT_HOST`, `API_PORT_HOST`...).
- **No editar a mano en el servidor**: cambios en local → commit → push → `git pull`.

## Limitaciones conocidas (resumen)
- Modelo pequeño (3b/7b): function calling poco fiable (de ahí los pre-flights) y mezcla campos al extraer facturas. Detalle y resto de limitaciones en `NOTAS.md`.
- Tipos permitidos: PDF, DOCX, XLSX, TXT, CSV, JPEG, PNG, WEBP. Máx 50 MB. Subida: 1 archivo/petición (paralelas en el front).

## Preferencias de trabajo (Vlad)
- **Solo pedir confirmación para decisiones de diseño**, no para llamadas de herramienta rutinarias.
