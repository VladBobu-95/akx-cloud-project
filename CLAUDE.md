# AKX Cloud — Monorepo (akx-cloud-project)

## Descripción

App de almacenamiento en la nube con chatbot IA. Monorepo con backend Node/TypeScript y frontend Angular 22.

**Repo:** `https://github.com/VladBobu-95/akx-cloud-project`

```
akx-cloud-project/
  backend/                  ← API REST (Express + TypeORM + pgvector + MinIO + Ollama)
  frontend/                 ← SPA Angular 22
  docker-compose.yml        ← Producción: db, minio, api, web
  docker-compose.override.yml ← Solo local: añade ollama y adminer
  .env                      ← Secretos (no commitear, ver .env.example)
  CLAUDE.md
```

---

## Stack

| Capa | Tecnología |
|---|---|
| API | Node 22, Express 5, TypeScript 6 |
| ORM | TypeORM 1.x + PostgreSQL 16 + pgvector |
| Objetos | MinIO (S3-compatible) |
| IA chat | Ollama — `qwen2.5-coder:14b` (servidor con GPU); `qwen2.5:3b/7b` como fallback en máquinas pequeñas |
| IA embeddings | Ollama — `bge-m3` (1024 dims, multilingüe) |
| OCR facturas | Ollama visión — `deepseek-ocr` (`OLLAMA_OCR_MODEL`); Tesseract.js como fallback |
| Extracción PDF | pdf-parse v2 |
| Extracción DOCX | mammoth |
| Auth | JWT + bcrypt |
| Validación | Zod |
| Frontend | Angular 22, signals, standalone components |
| Estilos | SCSS inline + CSS custom properties (tema verde) |
| Markdown | marked v18 |

---

## Arrancar en local

```bash
# 1. Copiar y rellenar el .env
cp .env.example .env   # editar con valores reales

# 2. Levantar todos los servicios
docker compose up -d

# 3. Descargar modelos de Ollama (solo la primera vez)
docker exec clouddrive-ollama ollama pull qwen2.5-coder:14b   # o qwen2.5:3b en máquinas pequeñas
docker exec clouddrive-ollama ollama pull bge-m3
docker exec clouddrive-ollama ollama pull deepseek-ocr        # OCR de facturas (opcional, hay fallback)
```

| URL | Servicio |
|---|---|
| `http://localhost` | Frontend (nginx) |
| `http://localhost:3000` | API |
| `http://localhost:8080` | Adminer (gestor BD) |
| `http://localhost:9001` | MinIO Console |

---

## Variables de entorno (.env)

```env
# Postgres
DB_USER=clouddrive
DB_PASSWORD=rootpass
DB_NAME=clouddrive
DB_PORT_HOST=5433

# MinIO
MINIO_USER=minioadmin
MINIO_PASSWORD=rootpass
MINIO_BUCKET=archivos
MINIO_PORT_HOST=9000
MINIO_CONSOLE_HOST=9001

# API
API_PORT_HOST=3000
JWT_SECRET=<mínimo 32 chars aleatorios>

# Ollama (en local lo sobreescribe el override a http://ollama:11434;
# en el servidor apunta al Ollama externo con GPU vía host.docker.internal)
OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5-coder:14b
OLLAMA_EMBED_MODEL=bge-m3
OLLAMA_OCR_MODEL=deepseek-ocr
```

> El servicio `api` del `docker-compose.yml` incluye `extra_hosts: host.docker.internal:host-gateway`
> para que el contenedor pueda alcanzar el Ollama del host/servidor en Linux.

---

## Docker Compose

- `docker-compose.yml` — producción: db, minio, api, web
- `docker-compose.override.yml` — solo local: ollama + adminer, cambia OLLAMA_URL a `http://ollama:11434`

```bash
docker compose up -d                        # levantar todo
docker compose build api                    # rebuild imagen API tras cambios de código
docker compose up -d api                    # recrear contenedor API (recarga .env)
docker compose restart api                  # SOLO reinicia, NO recarga .env ni código
docker compose build frontend && docker compose up -d web  # rebuild frontend
docker compose logs -f api                  # logs en tiempo real
```

**Importante:** `restart` no recarga .env ni código. Para cambios de código: `build` + `up -d`. Para cambios de .env: solo `up -d`.

---

## Estructura backend (`backend/`)

```
src/
  config/
    database.ts      ← TypeORM DataSource (pgvector habilitado)
    env.ts           ← Zod schema de env vars (falla al arrancar si falta algo)
    minio.ts         ← Cliente MinIO + inicialización del bucket
  controllers/       ← Entrada HTTP, delegan en services
  entities/
    Archivo.ts       ← Metadatos de fichero (binario en MinIO), soft delete
    Carpeta.ts       ← Carpetas virtuales persistidas en BD
    Factura.ts       ← Cabecera de factura escaneada
    LineaFactura.ts  ← Líneas de una factura
    Usuario.ts       ← Usuario con hash bcrypt
  middlewares/
    auth.middleware.ts        ← Verifica JWT → req.usuario
    errorHandler.middleware.ts ← AppError → respuesta JSON con statusCode
  migrations/        ← TypeORM migrations (ejecutadas automáticamente al arrancar)
  routes/
  services/
    archivos.service.ts   ← CRUD, papelera, carpetas zip, texto RAG
    auth.service.ts       ← Registro/login JWT
    carpetas.service.ts   ← Carpetas: mover/copiar/vaciar/borrar con contenido
    chat.service.ts       ← Chatbot IA (ver sección CHAT)
    extraccion.service.ts ← Extrae texto de PDF/DOCX/txt/imagen
    facturas.service.ts   ← Escaneo (OCR deepseek-ocr), auto-escaneo al subir,
                            analítica filtrable (ventasTop, totalesFacturado)
    rag.service.ts        ← Embeddings bge-m3, indexación, búsqueda semántica
```

---

## API Routes

Todas requieren `Authorization: Bearer <token>` salvo `/api/auth/*`.

### `/api/auth`
| Método | Ruta | Body |
|---|---|---|
| POST | `/registro` | `{email, password, nombre}` — máx. 5/hora por IP (solo en producción) |
| POST | `/login` | `{email, password}` → `{usuario, token}` — máx. 10/15min por IP (solo en producción) |
| GET | `/perfil` 🔒 | → `{usuario}` |
| PATCH | `/perfil` 🔒 | `{nombre?, avatar?, password?}` — `avatar` es un data URL base64 (`""` para quitarlo); `password` min. 8 chars |

### `/api/archivos`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/subir` | multipart: campo `archivo` + `carpeta` opcional |
| GET | `/` | query: `carpeta`, `pagina`, `limite` |
| GET | `/buscar` | Búsqueda semántica RAG — query: `q` |
| GET | `/papelera` | |
| DELETE | `/papelera` | Vacía papelera |
| GET | `/carpeta/descargar` | .zip — query: `ruta` |
| GET/POST | `/carpetas` | Listar / Crear `{ruta}` |
| PATCH | `/carpetas` | Mover/renombrar `{origen, destino}` |
| DELETE | `/carpetas` | query: `ruta` |
| GET | `/:id` | Metadata del archivo (sin descargar el binario) |
| PATCH | `/:id` | `{nombre?, carpeta?}` |
| POST | `/:id/copiar` | `{carpeta?, nombre?}` |
| PATCH | `/:id/restaurar` | Restaurar de papelera |
| GET | `/:id/descargar` | 302 a URL firmada MinIO |
| DELETE | `/:id/permanente` | Borrado definitivo |
| DELETE | `/:id` | Soft delete (papelera) |

### `/api/chat`
| Método | Ruta | Body |
|---|---|---|
| POST | `/` | `{mensajes: [{rol: "usuario"\|"bot", contenido}]}` → `{respuesta, acciones[], archivo?: {id, nombre}}` |

`archivo` solo viene cuando la respuesta se resolvió sobre un archivo concreto (p. ej.
`obtener_factura` o el pre-flight de "abre/muestra factura X"): el frontend lo usa para
mostrar un botón "Abrir archivo" bajo la respuesta.

### `/api/facturas`
| Método | Ruta | Body |
|---|---|---|
| POST | `/escanear` | `{archivoId, pista?}` |

---

## Schema de BD

### `usuarios`
- `id` UUID, `email` unique, `nombre`, `avatar` (data URL base64, nullable)
- `passwordHash` (bcrypt), `rol` (`"user"` | `"admin"`, default `"user"`) — existe un
  middleware `soloAdmin` para rutas de admin, pero ninguna ruta lo usa todavía
- `creadoEn`

### `archivos` — metadatos de fichero
- `id` UUID, `nombre`, `carpeta` (ruta `/facturas/2026`), `mimeType`
- `tamanoBytes` bigint, `claveMinio` (clave S3), `hashSha256`
- `textoExtraido` text (para RAG, primeros 20k chars)
- `eliminadoEn` DeleteDateColumn (soft delete)
- `propietario` → `usuarios` CASCADE

### `carpetas` — carpetas vacías persistidas
- `id` UUID, `ruta` unique por propietario, `creadoEn`

### `facturas`
- `propietario`, `archivo` (nullable, CASCADE)
- `numero`, `fecha` date, `emisor`, `cliente`
- `subtotal`, `iva`, `total` numeric(12,2)
- `lineas` → `lineas_factura` cascade

### `lineas_factura`
- `descripcion`, `cantidad`, `precioUnit`, `total` numeric

### `fragmentos` — chunks para RAG
- `archivoId`, `propietarioId`, `indice` int
- `texto` text, `embedding` vector(1024) (bge-m3)

---

## Servicio de Chat (`backend/src/services/chat.service.ts`)

### Flujo principal

1. **Solo el último mensaje**: al modelo se le envía únicamente el último mensaje del usuario (no el historial). Reenviar turnos previos hacía que modelos pequeños **re-ejecutaran** acciones anteriores (p. ej. repetir `borrar_todo` al pedir cualquier cosa). Cada orden de archivos es independiente.

2. **Pre-flights deterministas por regex**: para frases muy comunes, no se confía en que el modelo elija la tool correcta — se resuelven directamente contra la BD, sin llamar a Ollama:
   - **Borrados masivos**: distingue "borra todo" (`borrar_todo`, incluida la raíz), "borra todas las carpetas" (`borrar_todas_carpetas`, con su contenido, sin tocar lo suelto en la raíz) y "borra todos los archivos/ficheros" (`borrar_todos_archivos`, sin tocar carpetas).
   - **Listado combinado**: "lista/pásame todo lo que tengo" (archivos + carpetas), con soporte para acotar a una carpeta concreta o solo la raíz.
   - **¿Qué hay en la papelera?**: el prompt de facturas es grande y sesgaba al modelo hacia esas tools para esta pregunta (devolvía contenido random no relacionado); se resuelve aquí con `listar_papelera`.
   - **Existencia/ubicación de un archivo** ("¿tengo/hay/existe... archivo X?", "dónde está/busca el archivo X"): comprobación instantánea con `buscar_archivos`. Sin esto, el modelo a veces decidía "comprobar" escaneando con OCR (lento, y en servidores sin GPU puede acabar tirando el proceso — se ve como "no se puede conectar con el servidor" en el front).
   - **Abrir/mostrar una factura** ("abre/muéstrame factura_X"): lee siempre de BD vía `obtener_factura`, nunca relanza un escaneo OCR. Si la factura no se ha escaneado, lo dice al instante en vez de escanearla sin que se pida (antes parecía que la petición "no funcionaba" cuando en realidad el modelo se había puesto a escanear por su cuenta).

3. **Bucle de herramientas** (máx 15 iter): llama Ollama → si hay `tool_calls` → ejecuta → repite. Varios refuerzos:
   - **Parser de respaldo de tool calls**: si el modelo escribe las llamadas como **texto JSON** en `content` (en vez de en `tool_calls`), se extraen con un escáner de llaves balanceadas (admite varias pegadas) y se ejecutan igual.
   - **Remapeo de nombres alucinados** (`remapearNombreTool`): el modelo a veces se inventa nombres como `mover_factura`/`copiar_factura` en vez de los reales `mover_archivo`/`copiar_archivo` (una factura es un archivo normal, no hay tools específicas). Se remapea por regex (`<verbo>_facturas?` → `<verbo>_archivo`, `borrar` → `eliminar`) tanto en el parser de texto como en `tool_calls` reales, así la acción se ejecuta de verdad en vez de devolver un error genérico.
   - **Resolución flexible de nombres** (`resolverArchivo`/`resolverCarpeta`): búsqueda por nombre/leaf-name (no hace falta la ruta completa) en **todas las carpetas**, con fallback archivo↔carpeta cuando una operación de carpeta en realidad apunta a un archivo (y viceversa). Si hay varias coincidencias, la tool devuelve `necesita_aclaracion` con las opciones reales.
   - **Bypass de aclaración**: cuando una tool devuelve `necesita_aclaracion` con `opciones`, la lista se construye **en el servidor** y se devuelve directa — dejarlo en manos del modelo a veces resultaba en "¿cuál quieres?" sin listar ninguna opción real.
   - **Bypass de resumen**: si TODAS las herramientas de una iteración devuelven `resumen: string`, se retorna ese markdown directamente sin otra llamada al modelo (evita que reformatee mal, use `$` en vez de `€`, o invente datos). Se usa en facturas y en **todas** las operaciones de archivos/carpetas/papelera (`resumen: "Hecho."`).

`temperature: 0` y `keep_alive: 30m`.

### Herramientas disponibles al modelo
`buscar_archivos`, `copiar_archivo`, `mover_archivo`, `renombrar_archivo`, `eliminar_archivo`, `crear_archivo`, `crear_carpeta`, `listar_carpetas`, `eliminar_carpeta`, `vaciar_carpeta`, `mover_carpeta`, `renombrar_carpeta`, `copiar_carpeta`, `borrar_todo`, `borrar_todas_carpetas`, `borrar_todos_archivos`, `listar_papelera`, `restaurar_archivo`, `borrar_permanente`, `vaciar_papelera`, `leer_archivo`, `estadisticas`, `buscar_semantica`, `escanear_factura`, `escanear_todas_facturas`, `obtener_factura`, `ventas_top`, `totales_facturas`

### Analítica de facturas (`ventas_top`, `totales_facturas`)
Ambas aceptan un **filtro flexible** y devuelven markdown con € (bypass): `facturas` (nº o nombre de archivo; matching con límites de dígito para que "1" no case con "10"), `cliente`, `emisor`, `producto` (solo ranking), `mes`/`anio` o `desde`/`hasta`, `orden` (más/menos vendido). Si se nombran facturas concretas que aún **no están escaneadas**, se **escanean al vuelo** (`asegurarFacturasEscaneadas`) antes de agregar.

### Tools con bypass (devuelven markdown preconstruido, con € server-side)
- `escanear_factura` → OCR (deepseek-ocr) + extracción JSON forzada con Ollama → guarda en BD → markdown
- `obtener_factura` → resuelve el archivo con `resolverArchivo` (mismo buscador que el resto de tools, con manejo de ambigüedad/no-encontrado) y lee de BD directamente, sin re-escanear el PDF. Antes buscaba con `ILIKE %nombre%` sin validar nombre vacío/ambiguo y se podía quedar con un archivo arbitrario (devolvía la factura de **otro** archivo); ahora no puede pasar.
- `ventas_top` → ranking de productos (SQL GROUP BY sobre `lineas_factura`)
- `totales_facturas` → totales (nº facturas, subtotal, IVA, total) filtrados

El markdown de una factura (`resumenFacturaMd`, usado tanto en el chat como en el
`.md` de resumen que se genera al escanear) usa `##` igual que `ventas_top`/
`totales_facturas`, y el título incluye el nombre del archivo junto al número de
factura (`## Factura 2026-2003 — factura_03.pdf`) para que no haya desconexión entre
lo que se pidió y lo que aparece.

### Abrir archivo desde el chat
Cuando `obtener_factura` (o el pre-flight de "abre/muestra factura") resuelve un
archivo concreto, `chatear()` devuelve `archivo: {id, nombre}` además de la respuesta.
El frontend (`pages/inicio/inicio.ts`) muestra un botón "Abrir `<nombre>`" bajo el
mensaje; al pulsarlo abre el archivo en una pestaña nueva igual que en el explorador
(PDF/imagen/texto se previsualizan, el resto se descarga). La ventana se abre en
blanco **en el momento del clic** (antes de pedir el blob) para que el navegador no la
bloquee como pop-up — abrir una pestaña fuera de un gesto de clic directo se bloquea.

---

## Pipeline RAG (`backend/src/services/rag.service.ts`)

Al subir un archivo se indexa en background:
1. Extrae texto (`extraccion.service.ts`: pdf-parse / mammoth / Tesseract OCR)
2. Trocea en chunks de **1000 chars con solape de 150**
3. Genera embeddings con **bge-m3** (1024 dims) vía `POST /api/embed` de Ollama
4. Guarda en tabla `fragmentos` con columna `embedding vector(1024)`

Búsqueda semántica:
- Genera embedding de la consulta
- Búsqueda **híbrida**: distancia coseno (`<=>`) OR `ILIKE` para keywords exactas
- `MIN_SCORE = 0.50` calibrado para bge-m3 en español
- Devuelve un fragmento representativo por archivo (deduplicado por archivoId)

---

## Auto-escaneo de facturas al subir

Al subir un PDF/imagen, además de indexarlo para RAG, el controlador (`ctrlSubir`) dispara
`autoEscanearArchivo` **en segundo plano** (fire-and-forget, igual que el RAG):

1. Si el archivo es PDF/imagen, se escanea con `escanearFactura(..., { soloSiFactura: true })`.
2. **Guardia**: solo persiste la factura si la extracción parece factura (tiene líneas o
   importes > 0). Así no se crean facturas basura a partir de PDFs/imágenes cualesquiera.

Resultado: la analítica de facturas funciona sin pasos manuales. Para facturas ya subidas
antes de esta función, usar "escanea todas las facturas" en el chat (o nombrarlas, que se
auto-escanean al consultarlas).

---

## Estructura frontend (`frontend/`)

```
src/
  app/
    core/
      archivos.service.ts   ← CRUD archivos, carpetas, escanear factura, búsqueda RAG, obtener metadata
      auth.service.ts       ← Login/registro, token en localStorage, signal usuario
      auth.guard.ts         ← Redirige a /login si no hay token
      auth.interceptor.ts   ← Añade Authorization: Bearer a todas las peticiones
      chat.service.ts       ← Historial en signal + localStorage (clave: akx_chat)
      models.ts             ← Interfaces TS: Usuario, Archivo, ListaArchivos, ResultadoBusqueda
      theme.service.ts      ← Toggle dark mode (clase body.dark)
      toast.service.ts      ← Cola de notificaciones toast (signal)
    layout/
      shell.ts              ← Navbar: logo, nav links, avatar, cerrar sesión
    pages/
      login/login.ts        ← Login + registro en tabs
      inicio/inicio.ts      ← Chat con el asistente IA; botón "Abrir archivo" cuando la respuesta resuelve uno
      archivos/archivos.ts  ← Explorador: tabla, carpetas, drag&drop, menú contextual, RAG
      papelera/papelera.ts  ← Restaurar / borrar permanente / vaciar
      perfil/perfil.ts      ← Editar nombre y avatar
    shared/
      file-size.pipe.ts     ← Formatea bytes → KB/MB/GB
      toasts.component.ts   ← Renderiza cola de toasts
      errores.ts            ← mensajeError(err): extrae string legible de HttpErrorResponse
    app.routes.ts           ← /login, /inicio, /archivos, /papelera, /perfil
    app.config.ts           ← provideRouter + provideHttpClient con interceptor JWT
  styles.scss               ← CSS custom properties (verde/blanco + modo oscuro)
```

### Página archivos (más compleja)
- Árbol de carpetas construido en cliente (carga TODOS los archivos + carpetas de BD)
- Drag & drop con eventos `pointer` (no HTML5 DnD)
- Menú contextual (clic derecho): abrir, escanear factura, descargar, copiar, renombrar, mover, borrar
- Visor de `.md` con `marked` en modal
- Selección múltiple + barra de acciones bulk (copiar/mover/borrar)
- Búsqueda semántica RAG integrada

### Tema (`styles.scss`)
```scss
--green: #16a34a        /* acento principal */
--green-dark: #11823b
--green-soft: #e9f9ef   /* hover, fondos suaves */
--bg, --surface, --text, --muted, --border, --danger
--radius: 12px
```
Modo oscuro: clase `body.dark` sobreescribe las variables.

### Dev local del frontend
```bash
cd frontend
npm install
npm start    # ng serve → http://localhost:4200
             # proxy.conf.json → /api redirige a localhost:3000
```

---

## Limitaciones conocidas

- **Modelo del chat**: en el servidor con GPU se usa `qwen2.5-coder:14b` (function calling fiable). En máquinas pequeñas, `qwen2.5:3b` tiene function calling poco fiable; el pre-flight, el parser de respaldo y el bypass son los workarounds que lo hacen usable.
- **Cambiar de modelo**: editar `OLLAMA_MODEL` en `.env` y `docker compose up -d api` (recarga .env, sin rebuild). El modelo debe estar descargado en el Ollama correspondiente.
- **PDFs escaneados (sin capa de texto)**: se leen con `pdf-parse`, que no hace OCR; solo las **imágenes** pasan por deepseek-ocr. Si una factura es un PDF puramente escaneado, habría que rasterizar las páginas a imagen antes del OCR (pendiente).
- **Auto-escaneo al subir**: se ejecuta para todo PDF/imagen subido; con la guardia `soloSiFactura` no guarda los que no parecen factura, pero igualmente consume cómputo de OCR+IA por cada uno.
- **Tipos de archivo permitidos**: PDF, DOCX, XLSX, TXT, CSV, JPEG, PNG, WEBP. Máximo 50 MB.
- **Subida**: un archivo por petición HTTP; múltiples archivos → peticiones paralelas en el frontend.
- El chat no renderiza markdown (los `resumen`/`acciones` se muestran como texto plano con `white-space: pre-wrap`, no como HTML); los `#`/`**`/tablas se ven tal cual en vez de formateados.

## Despliegue (servidor)

- Monorepo clonado en el servidor; `docker compose build api && docker compose up -d api` tras `git pull`.
- En el servidor **se borra `docker-compose.override.yml`** (no se usa Ollama en contenedor): la API apunta al Ollama externo con GPU vía `OLLAMA_URL=http://host.docker.internal:11434` + `extra_hosts`.
- La API está detrás de nginx (servicio `web`): `app.set("trust proxy", 1)` en `app.ts` para que `express-rate-limit` lea bien la IP (X-Forwarded-For).
- Puertos del host configurables por `.env` (`WEB_PORT_HOST`, `API_PORT_HOST`, `MINIO_PORT_HOST`, etc.) para evitar choques con otros servicios del servidor.
- **No editar archivos a mano en el servidor**: cambios en local → commit → push → `git pull` (evita conflictos de merge).
