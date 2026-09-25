# ATEKA Cloud — Monorepo (akx-cloud-project)

App de almacenamiento en la nube con chatbot IA. Backend Node/TypeScript + frontend Angular 22.

**Repo:** `https://github.com/VladBobu-95/akx-cloud-project`

> El **detalle y el porqué** de cada decisión (chat por SQL y su frontera de seguridad, cascada OCR,
> historial de bugs, limitaciones) está en **`NOTAS.md`** — que NO se carga cada sesión.
> Este `CLAUDE.md` es la referencia compacta de uso frecuente; consulta `NOTAS.md` cuando
> toques chat/OCR/facturas en profundidad.

```
akx-cloud-project/
  backend/                    ← API REST (Express + TypeORM + Postgres + MinIO + Ollama)
  frontend/                   ← SPA Angular 22
  mobile/                     ← App Android (Ionic 9 + Capacitor 8). URLs de ATEKA y del gateway en src/environments/ (vía core/urls.ts)
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
| ORM | TypeORM + PostgreSQL 16 |
| Objetos | MinIO (S3-compatible) |
| IA chat + facturas | Ollama — `qwen3:14b` (servidor, GPU de 12 GB); el chat lee la BD escribiendo SQL de solo lectura |
| Visión/OCR | Cascada granite3.2-vision → deepseek-ocr → Tesseract.js `spa+cat+eng` (ver `NOTAS.md`) |
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
docker exec clouddrive-ollama ollama pull qwen3:14b
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
SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD                          # seed del superadmin (multi-tenant; ver abajo)
OLLAMA_URL=http://host.docker.internal:11434                   # local override → http://ollama:11434
OLLAMA_MODEL=qwen3:14b                                         # chat (SQL) + extracción de facturas
OLLAMA_THINK=false                                             # opcional: modo pensamiento (mejor SQL, más lento)
OLLAMA_NUM_CTX=8192                                            # opcional: contexto del chat y de las facturas
OLLAMA_CAPTION_MODEL=granite3.2-vision                         # 1ª pasada visión
OLLAMA_OCR_MODEL=deepseek-ocr                                  # 2ª pasada (solo si parece factura)
N8N_API_KEY, N8N_USER_EMAIL                                    # opcional: key fija de pruebas para /api/n8n (actúa como ese usuario)
```
`env.ts` valida con Zod y **falla al arrancar** si falta algo. Cambiar de modelo: editar
`.env` + `docker compose up -d api` (recarga .env, sin rebuild).

## Multi-tenant (SaaS)
App vendible a **varias empresas** sobre una sola instancia. Niveles de cuenta en
`Usuario.rol`: `superadmin` (dueño de la plataforma, sin empresa, gestiona empresas) ·
`admin` (administra SU empresa) · `miembro` (empleado). Cada usuario pertenece a una
`Empresa` (tenant) salvo el superadmin. **No hay auto-registro**: el superadmin crea
empresas + su primer admin (`/api/plataforma`), y el admin crea miembros (`/api/equipo`,
Fase 2). El superadmin se **siembra al arrancar** desde `SUPERADMIN_EMAIL/PASSWORD` si no
existe ninguno (`seed.service.ts`). El JWT lleva `empresaId`; empresa `suspendida` bloquea
login y cada petición (`auth.middleware.ts`). Roles funcionales configurables + carpetas
compartidas: Fases 2-3 (ver `~/.claude/plans/`).

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
config/      database.ts (TypeORM), chatDb.ts (conexión del rol ateka_chat del chat), env.ts (Zod), minio.ts, ollama.ts
controllers/ entrada HTTP, delegan en services
entities/    Empresa, Rol, CarpetaCompartida, Archivo, Carpeta, Factura, LineaFactura, Usuario, ClaveApi, Tarea, EventoCompartido
middlewares/ auth (JWT→req.usuario; verificarToken/soloAdmin/soloSuperadmin/exigirCapacidad→exigirGestionArchivos), n8n (X-Api-Key→req.usuario), limites, validarUUID, errorHandler (AppError→JSON)
migrations/  TypeORM, se ejecutan al arrancar
services/
  archivos.service.ts    CRUD, papelera, carpetas zip
  auth.service.ts        login JWT (sin registro público)
  claves.service.ts      claves API de n8n por usuario: crear/listar/revocar (máx 5 activas; solo se guarda el hash SHA-256)
  plataforma.service.ts  superadmin: alta/edición/borrado de empresas + su admin
  equipo.service.ts      admin: miembros CRUD, roles configurables, capacidadesDe, archivos de un miembro
  seed.service.ts        siembra el superadmin al arrancar (multi-tenant)
  carpetas.service.ts    mover/copiar/vaciar/borrar con contenido
  compartido.service.ts  carpetas compartidas por rol: CRUD admin, acceso por empresa+roles, subir/listar/descargar/borrar (almacenamiento único, dedup por hash)
  chat.service.ts        chatbot IA por SQL de solo lectura (ver abajo + NOTAS.md)
  contenido.service.ts   texto extraído / descripción manual de cada archivo + buscador del explorador (nombre y contenido, sin IA)
  extraccion.service.ts  texto de PDF/DOCX/txt + cascada OCR de imágenes
  facturas.service.ts    escaneo, auto-escaneo, clasificación venta/compra (CIF/nombre), edición manual, listados paginados
```

---

## API Routes
Todas requieren `Authorization: Bearer <token>` salvo `/api/auth/*`.

### `/api/auth`
| Método | Ruta | Body |
|---|---|---|
| POST | `/login` | `{email, password}` → `{usuario, token}` (máx 10/15min en prod). **No hay `/registro`** |
| GET/PATCH | `/perfil` 🔒 | PATCH `{nombre?, avatar?, password?}` — avatar = data URL base64 (`""` quita) |

### `/api/plataforma` 🔒 superadmin
| Método | Ruta | Notas |
|---|---|---|
| GET | `/empresas` | lista de empresas + `usuariosCount` |
| POST | `/empresas` | `{nombre, nif?, admin:{email,password,nombre}}` → crea empresa + su primer admin (transacción) |
| PATCH | `/empresas/:id` | `{nombre?, nif?, estado?}` — `estado` = `activa`\|`suspendida`; `nif` = CIF (ancla venta/compra) |
| DELETE | `/empresas/:id` | borra empresa (CASCADE a usuarios y su contenido en BD) |

### `/api/equipo` 🔒 admin (scoped a su empresa)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/capacidades` | vocabulario fijo de capacidades (para los toggles) |
| GET/PATCH | `/empresa` | datos de la propia empresa (`{id,nombre,nif}`) / editar `{nif?}` — el CIF ancla venta/compra (se auto-aprende al escanear; editable aquí) |
| GET/POST | `/usuarios` | listar miembros / crear `{nombre,email,password,rol,rolesIds[]}` (`rol`=`miembro`\|`admin`) |
| PATCH/DELETE | `/usuarios/:id` | editar (incl. `password?`, `rolesIds?`) / eliminar (no a uno mismo) |
| GET | `/usuarios/:id/archivos` | archivos del miembro (paginado) → `{archivos,total,paginas}` |
| GET/POST | `/roles` | listar / crear `{nombre, capacidades[]}` |
| PATCH/DELETE | `/roles/:id` | editar `{nombre?, capacidades?}` / eliminar |

### `/api/compartido` (carpetas compartidas por rol — Fase 3)
Acceso por **empresa + roles**, no por propietario. Admin (`/admin*`) gestiona; cualquier miembro con un rol asignado a la carpeta la usa. Almacenamiento **único** (lo que sube uno lo ven todos los del rol). Los archivos compartidos **no van a la papelera** (borrado directo). Dentro de cada carpeta compartida el explorador es **idéntico a "Mis archivos"** (mismo `ExploradorComponent` en el front): subcarpetas persistidas, mover/renombrar/copiar, drag&drop (con **arrastre múltiple**), selección múltiple y descarga zip. **Mover/copiar en 3 direcciones**: (a) **Personal ↔ Compartido**: drag entre toggles "Personales"/"Compartido" **MUEVE**; personal→compartido abre selector si hay varias; (b) **Compartido ↔ Compartido**: "Mover a…"/"Copiar en…" ofrecen otras carpetas compartidas accesibles como destino (excluida la actual); (c) **Personales**: drag/menús internos. Mover reasigna en sitio (misma claveMinio, sin re-subir); copiar duplica. Dedup por hash; al pasar archivo a personal, auto-escaneo de factura como propia. Acceso enforzado por empresa + roles en ambos extremos (backend verifica acceso a origen + destino).
| Método | Ruta | Notas |
|---|---|---|
| GET/POST | `/admin` 🔒 admin | listar carpetas de la empresa (con roles) / crear `{nombre, rolesIds[]}` (nombre único por empresa) |
| PATCH/DELETE | `/admin/:id` 🔒 admin | editar `{nombre?, rolesIds?}` / borrar (CASCADE a sus archivos + subcarpetas + binarios MinIO) |
| GET | `/` | carpetas compartidas accesibles → `{id,nombre}[]` (admin=todas de su empresa; miembro=las de sus roles) |
| GET | `/:id/archivos` | query `carpeta` → `{archivos, subcarpetas[]}` (subcarpetas derivadas de las rutas) |
| GET | `/:id/todos` | **todos** los archivos de la carpeta compartida (para el árbol en cliente, como `listarTodos` personal) |
| GET | `/:id/buscar` | buscador por nombre y contenido **acotado a esta carpeta compartida** — query `q` (como `/api/archivos/buscar` pero solo en este espacio) |
| GET/POST | `/:id/carpetas` | listar subcarpetas explícitas (incl. vacías) → `{ruta,creada}[]` / crear `{ruta}` |
| PATCH/DELETE | `/:id/carpetas` | mover/renombrar `{origen,destino}` (con contenido) / borrar `?ruta=` (solo metadata; los archivos los borra el front) |
| GET | `/:id/carpeta/descargar` | .zip de una subcarpeta — query `ruta` |
| POST | `/:id/subir` | multipart `archivo` + `carpeta` opcional; dedup por hash (mismo contenido → `{...,duplicado:true}` 200) |
| GET | `/archivo/:archivoId/descargar` | streaming del binario (verifica acceso por la carpeta) |
| PATCH | `/archivo/:archivoId` | renombrar/mover dentro de la carpeta compartida `{nombre?, carpeta?}` |
| POST | `/archivo/:archivoId/copiar` | duplica el archivo (binario + texto extraído) `{carpeta?, nombre?}` |
| POST | `/archivo/:archivoId/copiar-a-personal` | **copia** el archivo al espacio **personal** del usuario (el original sigue en compartido) `{carpeta?}`. Copia **siempre** (sin dedup): conserva el nombre y añade "(copia)"/"(copia N)" solo si ya existe en la carpeta destino (como el copiar del explorador), y auto-escaneo de factura como propia. El front lo usa desde "Copiar en… › Mis archivos" |
| POST | `/archivo/:archivoId/mover-a-personal` | **mueve** el archivo al espacio personal (reasigna en sitio, misma claveMinio; **desaparece del compartido para todos**) `{carpeta?}`. **Sin dedup** (reubica siempre a la carpeta destino; "(copia)" si el nombre choca), auto-escaneo como propia. Usado por "Mover a… › Mis archivos" y al **arrastrar** sobre "Personales" |
| POST | `/:id/mover-desde-personal` | **mueve** un archivo **personal** a esta carpeta compartida `{archivoId, carpeta?}` (deja de ser personal; sale de la analítica de facturas). Usado por "Mover a… › Compartido" y al arrastrar sobre "Compartido" |
| POST | `/:id/copiar-desde-personal` | **copia** un archivo **personal** a esta carpeta compartida `{archivoId, carpeta?}` (el original permanece). Copia **siempre** (sin dedup): "(copia)"/"(copia N)" si el nombre ya existe en el destino. Usado por "Copiar en… › Compartido" |
| POST | `/:id/mover-desde-compartido` | **mueve** un archivo de **otra carpeta compartida** a esta `{archivoId, carpeta?}` (desaparece del compartido de origen para todos los del rol). Dedup por hash, reasigna en sitio sin re-subir. Usado por "Mover a… › [otra carpeta]" y al arrastrar |
| POST | `/:id/copiar-desde-compartido` | **copia** un archivo de **otra carpeta compartida** a esta `{archivoId, carpeta?}` (el original permanece). Copia **siempre** (sin dedup): "(copia)" si el nombre ya existe; duplica binario y texto extraído. Usado por "Copiar en… › [otra carpeta]" |
| DELETE | `/archivo/:archivoId` | borrado definitivo (afecta a todos los del rol) |

### `/api/archivos`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/subir` | multipart: `archivo` + `carpeta` opcional |
| GET | `/` | query `carpeta`, `pagina`, `limite` → body = `Archivo[]`, totales en headers `X-Total-Count`/`X-Total-Pages`/`X-Current-Page` |
| GET | `/buscar` | buscador por nombre y contenido (todas las palabras, sin tildes ni mayúsculas, también parciales) — query `q` → `{archivoId,nombre,carpeta,fragmento}[]`. Solo lo personal |
| GET/DELETE | `/papelera` | listar / vaciar |
| GET | `/carpeta/descargar` | .zip — query `ruta` |
| GET/POST/PATCH/DELETE | `/carpetas` | listar / crear `{ruta}` / mover `{origen,destino}` / borrar `?ruta=` |
| GET | `/:id` | metadata (sin binario) |
| PATCH | `/:id` | `{nombre?, carpeta?}` |
| POST | `/:id/copiar` | `{carpeta?, nombre?}` |
| PATCH | `/:id/restaurar` | de papelera (sufijo "(restaurado)" si colisiona) |
| PATCH | `/:id/descripcion` | `{descripcion}` — describe imagen a mano (la leen el chat y el buscador) |
| GET | `/:id/descargar` | streaming del binario por la API |
| DELETE | `/:id` / `/:id/permanente` | soft delete / borrado definitivo |

### `/api/chat`
| Método | Ruta | Body / Respuesta |
|---|---|---|
| POST | `/` | `{mensajes: [{rol, contenido}]}` (últimos 8, usuario y bot) → `{respuesta, tabla?}` |

`tabla` = `{columnas, filas, truncada}`: resultado de la última consulta con varias filas (máx. 200). El front la pinta bajo la respuesta; columnas `*_id` ocultas y botón "Abrir" si hay `archivo_id`.

### `/api/facturas`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/escanear` | `{archivoId, pista?}` — **asíncrono** (202): valida, marca `pendiente`, encola en background; resultado vía polling de la columna "Estado" |
| POST | `/reclasificar` | re-aplica venta/compra a las facturas YA escaneadas con el CIF/nombre actual de la empresa (sin re-escanear ni re-OCR) → `{actualizadas, total}`. Para cuando se fija el CIF **después** de escanear (si no, todo sale `desconocido`). Botón "↻ Reclasificar" en la página Facturas |
| GET | `/` | listado paginado — query `cliente`/`emisor`/`carpeta`/`desde`/`hasta`/`facturas`/`moneda`/`tipo`/`papelera`/`pagina`/`limite` → `{filas, total, paginas}`. `tipo`=`venta`\|`compra`\|`desconocido` (pestañas de la página Facturas). Cada fila trae `id/numero/fecha/emisor/cliente/tipo/subtotal/iva/total/moneda`. Lo usan la página Facturas y la paginación de tablas del chat |
| GET | `/:id` | detalle completo (cabecera + `lineas[]`) para el editor |
| PATCH | `/:id` | **edición manual** `{numero?,fecha?,emisor?,emisorNif?,cliente?,clienteNif?,tipo?,moneda?,subtotal?,iva?,total?,lineas?}` — corrige lo que la IA sacó mal y **regenera** el resumen individual + los agregados |

### `/api/claves` 🔒 (cualquier usuario, sobre SUS claves)
Claves API para n8n. El secreto (`ateka_live_…`; las antiguas `akx_live_…` siguen valiendo) se devuelve **solo al crear**; en BD va el hash SHA-256 (comparación en tiempo constante). En el front: página **Perfil**.
| Método | Ruta | Notas |
|---|---|---|
| GET | `/` | claves activas → `{id,nombre,prefijo,ultimoUso,creadoEn}[]` (nunca el secreto) |
| POST | `/` | `{nombre?}` (default `"n8n"`) → 201 con `{...,clave}`. Máx **5 activas** por usuario |
| DELETE | `/:id` | revoca (204). Solo las propias |

### `/api/n8n` (auth por cabecera `X-Api-Key`, **no** JWT)
La petición actúa **como el usuario dueño de la clave** (mismos permisos/capacidades; empresa suspendida → 403). Valida primero `N8N_API_KEY` del `.env` (→ usuario `N8N_USER_EMAIL`, para pruebas) y si no, las claves de `claves_api` (actualiza `ultimoUso`).
| Método | Ruta | Notas |
|---|---|---|
| POST | `/facturas` | multipart `archivo` + `carpeta` opcional — **misma tubería** que `/api/archivos/subir` (dedup, indexado, auto-escaneo de factura). Límites de subida y backlog |
| POST | `/chat` | `{mensaje}` (o `missatge`, o `{mensajes:[...]}` como `/api/chat`) + `chat_id`/`user_id` opcionales que se **devuelven tal cual** (para responder en Telegram). Mismo `chatear()` que el chatbot; la `tabla` va además en markdown dentro de `respuesta` |

---

## Schema de BD
- **empresas** (tenant): `id`, `nombre`, `nif` (CIF/NIF, nullable — ancla para clasificar facturas como venta/compra; se **auto-aprende** por corroboración y es editable), `estado` (`activa`|`suspendida`, default `activa`), `creadoEn`. `OneToMany` usuarios.
- **roles** (funcionales, por empresa): `id`, `nombre`, `capacidades` (`text[]` del vocabulario fijo `config/capacidades.ts`), `empresaId` (FK CASCADE), `creadoEn`. Único `(empresaId, nombre)`. N:N con usuarios vía **usuario_roles** (`usuarioId`,`rolId`, ambos CASCADE).
- **carpetas_compartidas** (Fase 3): `id`, `nombre`, `empresaId` (FK CASCADE), `creadoEn`. Único `(empresaId, nombre)`. N:N con roles vía **carpeta_compartida_roles** (`carpetaCompartidaId`,`rolId`). Acceso = empresa + roles (no propietario). Borrarla CASCADE a sus archivos y subcarpetas.
- **carpeta_compartida_carpetas**: `id`, `ruta` (canónica dentro de la carpeta compartida), `carpetaCompartidaId` (FK CASCADE), `creadaEn`. Único `(carpetaCompartidaId, ruta)`. Persiste las subcarpetas explícitas (incl. vacías) del explorador compartido, equivalente a `carpetas` para el espacio personal.
- **usuarios**: `id`, `email` unique, `nombre`, `avatar` (base64, null), `passwordHash`, `rol` (`superadmin`|`admin`|`miembro`, default `miembro`), `empresaId` (FK CASCADE, null solo para superadmin), `roles` (N:N), `creadoEn`.
- **archivos**: `id`, `nombre`, `carpeta` (ruta), `mimeType`, `tamanoBytes`, `claveMinio`, `hashSha256` (dedup al subir: idéntico contenido vivo → se reutiliza, no se reprocesa), `textoExtraido` (~20k chars; lo leen el chat y el buscador), `descripcionManual`, `estadoEscaneo`, `estadoIndexado`/`indexadoEn` (estado de la extracción de texto), `carpetaCompartidaId` (nullable, FK CASCADE — si va set, el archivo vive en una carpeta compartida en vez de en las carpetas personales del `propietario`), `eliminadoEn` (soft delete), `propietario` CASCADE.
- **carpetas**: `id`, `ruta` (unique por propietario), `creadoEn`.
- **tareas** (cola durable): `id`, `tipo` (`indexar`|`autoescanear`), `archivoId`/`usuarioId` CASCADE, `estado` (`pendiente`|`en_proceso`|`ok`|`error`), `prioridad`, `intentos`/`maxIntentos`, `disponibleEn` (backoff), `pista`, `error`. La procesa el worker (`tareas.service.ts`), que relee los bytes de MinIO → sobrevive a reinicios, reintenta y limita la concurrencia hacia Ollama (sustituye a las colas en memoria).
- **claves_api**: `id`, `nombre`, `prefijo` (recorte visible), `hash` unique (SHA-256 del secreto), `usuarioId` (FK CASCADE), `empresaId` (FK CASCADE, null), `ultimoUso`, `creadoEn`, `revocadaEn` (null = activa). Índice `(usuarioId, revocadaEn)`.
- **chat_accesos**: `token` PK (UUID de un solo uso), `usuarioId`, `compartidas` uuid[], `puedeFacturas`, `puedeContenido`, `expiraEn`. Sesión de una petición de chat: las vistas del esquema `chat` solo devuelven filas del token fijado en `app.chat_token`. El rol `ateka_chat` no puede leerla.
- **esquema `chat`** (vistas de solo lectura para el SQL del modelo): `chat.archivos`, `chat.carpetas`, `chat.carpetas_compartidas`, `chat.facturas`, `chat.lineas_factura` — columnas en snake_case, filtradas por el token. Único acceso del rol `ateka_chat` (migración `1779000000000-ChatSql`).
- **facturas**: `propietario`, `archivo` (nullable, CASCADE), `numero`, `fecha`, `emisor`, `emisorNif`, `cliente`, `clienteNif`, `tipo` (`venta`|`compra`|`desconocido`, default `desconocido` — ver "Facturas: venta/compra" abajo), `moneda` (código ISO 4217, default `EUR`; la IA la extrae de la factura), `subtotal`/`iva`/`total` numeric(12,2), `lineas` cascade. La analítica se **separa por tipo**: ventas (`ventas_top`/`clientes_top`/`totales_facturas`) vs compras (`compras_top`/`proveedores_top`/`totales_compras`); todo **agrupa por moneda** — nunca se suman divisas distintas. Los resúmenes son datos **derivados**: se calculan al vuelo desde la BD (página Facturas y SQL del chat); **ya no** se materializan como archivos `resumen-*.md` (ver `NOTAS.md`).
- **lineas_factura**: `descripcion`, `cantidad`, `precioUnit`, `total`.

---

## Chat (`chat.service.ts`) — resumen
**Sin tools ni regex.** El modelo lee la BD escribiendo SQL de solo lectura y redacta la respuesta. Detalle y porqué en `NOTAS.md`.
1. **Capacidad maestra `chat`**: sin ella, 403 antes de llamar a la IA (el front oculta `/inicio` vía `chatGuard` y `auth.puedeChat()`).
2. **Prompt** con el esquema de las vistas `chat.*`, la fecha de hoy, el nombre/CIF de la empresa, reglas SQL (excluir papelera, `unaccent ILIKE`, no sumar monedas distintas…) y ejemplos. Historial: últimos 8 mensajes.
3. **Bucle**: si el modelo responde con un bloque ```` ```sql ````, se ejecuta y se le devuelven las filas (o el error de Postgres para que corrija); hasta **4 consultas** por mensaje. Luego responde en markdown.
4. **Solo lectura**: mover/copiar/borrar/subir/restaurar se hace desde el explorador; el chat lo indica.
5. **Frontera de seguridad en la BD, no en el prompt**: el SQL corre con el rol `ateka_chat` (conexión propia, `config/chatDb.ts`), que solo puede leer las vistas `chat.*`; estas filtran por un token de un solo uso (`chat_accesos`) que el rol no puede leer. Una sola sentencia (protocolo extendido de pg), transacción `READ ONLY`, `statement_timeout` 10 s, máx. 200 filas. Tests: `tests/chat.sql.test.ts`.
6. **RBAC**: `facturas` → `chat.facturas` devuelve filas; `busqueda` → `chat.archivos.contenido` viene relleno (si no, NULL). Las partes del prompt de lo que no puede ver no se incluyen.
7. **Modelo**: `OLLAMA_THINK=true` activa el modo pensamiento (qwen3); `think` solo se manda a modelos que lo soportan (`soportaThink`). Mismo `OLLAMA_NUM_CTX` que la extracción de facturas para que Ollama no recargue el modelo al alternar.

## OCR, texto extraído y buscador — resumen
- **OCR imágenes** (`extraccion.service.ts`): cascada de 3 pasadas (granite → deepseek si parece factura → Tesseract si los VLM se quedan cortos), normalizando a PNG primero. Detalle completo en `NOTAS.md`.
- **Tesseract multi-idioma**: `IDIOMAS_OCR = "spa+cat+eng"` (traineddata vendorizados en `backend/tessdata/`, copiados por el Dockerfile) — para facturas escaneadas/fotos en catalán/inglés, no solo castellano. Ampliar = editar la cadena + añadir el `.traineddata`.
- **OCR de página en PDFs con texto** (rescate del membrete): solo se rasteriza+OCR-ea la 1ª página si el texto `pareceFacturaConImportes` **y NO** trae ya la línea "Registro/Registre/Rexistro Mercantil" (`tieneRegistroMercantil`). Si el emisor ya está en la capa de texto (ej. factura de la luz), el OCR solo añadiría ruido (leer "AKX"→"ARX"); se salta.
- **Texto extraído** (`contenido.service.ts`): al subir, la tarea `indexar` extrae el texto (PDF/DOCX/OCR) a `textoExtraido`. Sin embeddings (la búsqueda semántica con bge-m3 se quitó).
- **Buscador del explorador**: todas las palabras de la consulta en nombre/descripción/texto (`unaccent ILIKE`, también parciales), primero las que casan por nombre; devuelve un trozo del contenido. Uno para lo personal y uno por carpeta compartida.
- **Auto-escaneo de facturas al subir**: `ctrlSubir` encola una tarea durable `autoescanear` (`tareas.service.ts`), que corre `escanearFactura(..., {soloSiFactura:true})` en background; solo persiste si parece factura (`soloSiFactura`).

## Facturas: venta/compra + CIF (`facturas.service.ts`)
El sistema cataloga **ventas** (la empresa es el emisor) y **compras** (es el cliente). Todo determinista, en `escanearFactura`:
1. **Extracción IA** de emisor/cliente/**NIF de cada parte**/importes/líneas (prompt + JSON schema; el modelo pequeño confunde emisor↔cliente, de ahí los pasos siguientes).
2. **`reconciliarPartes`**: ancla el **emisor** en la razón social de la línea legal "…Registro Mercantil…" del pie (también catalán "Registre"/gallego "Rexistro", y extrae su NIF). Corrige inversiones (cliente = empresa del registro → swap) y duplicados (emisor==cliente → lo fija con el del pie), tolerando ruido OCR de nombres (`compartenTokenDistintivo`: "AKX"≈"ARX").
3. **`resolverDireccion`** (venta/compra/desconocido): por **CIF** de la empresa si se conoce (== emisorNif→venta, == clienteNif→compra); si el CIF del tenant aparece en el **texto** y el emisor es otro→compra; si no, por **parecido de nombre** contra `empresa.nombre`; `emisor==cliente`→desconocido.
4. **Auto-CIF por corroboración** (`intentarAprenderCifEmpresa`): fija `empresa.nif` cuando el mismo NIF del lado del tenant aparece en **≥2 facturas** (un NIF mal leído una vez no se cuela). Editable por el admin en `/api/equipo/empresa`.
- **Desconocido** = no se pudo clasificar (queda fuera de ambas analíticas). Se resuelve editándola en la página **Facturas** (pestaña "Sin clasificar").
- Heurísticas cubiertas por **tests** (`backend/tests/facturas.heuristicas.test.ts`, puros, sin BD/IA).

---

## Estructura frontend (`frontend/src/app/`)
```
core/    archivos/auth/chat/compartido/facturas/equipo/plataforma/theme/toast .service.ts, auth.guard, auth.interceptor (JWT), models.ts
layout/  shell (navbar)
pages/   login, inicio (chat), archivos (explorador + toggle Personales/Compartido → compartido.ts), facturas (tabla venta/compra/sin clasificar + editor), papelera, perfil, equipo (admin: miembros/roles/compartido + CIF), plataforma (superadmin)   [cada uno .ts/.html/.scss]
shared/  file-size.pipe, toasts.component, errores.ts (mensajeError)
app.routes.ts, app.config.ts (provideRouter + HttpClient con interceptor), styles.scss (tema)
```
- **Estado con signals** (sin NgRx). Standalone components. Markdown del bot con `marked` (`breaks: true`).
- **archivos.ts**: árbol de carpetas en cliente (carga todos los archivos), drag&drop con eventos `pointer`, menú contextual, selección múltiple, columna "Estado" (polling 3s), paginación en cliente.
- **facturas.ts**: tabla de facturas escaneadas con pestañas (Todas/Ventas/Compras/**Sin clasificar**), paginación server-side y **modal de edición** (corregir emisor/cliente/tipo/importes/líneas → `PATCH /api/facturas/:id`). Es la red de seguridad ante los fallos de extracción del modelo pequeño.
- **chat**: historial en signal + localStorage (`akx_chat`); se resetea al cambiar de sesión (`ChatService.reset()` desde `AuthService`) para no filtrarse entre usuarios. Respuesta en markdown + `tabla` genérica paginada en cliente (botón "Abrir" si hay `archivo_id`).
- **Tema** (`styles.scss`): `--green #16a34a`, `--green-dark`, `--green-soft`, `--bg/--surface/--text/--muted/--border/--danger`, `--radius 12px`. Modo oscuro: `body.dark`.

---

## Despliegue (servidor)
- `git pull` → `docker compose build api web && docker compose up -d api web`.
- En el servidor se **borra `docker-compose.override.yml`** (Ollama externo con GPU vía `OLLAMA_URL=http://host.docker.internal:11434` + `extra_hosts`).
- API detrás de nginx (servicio `web`): `app.set("trust proxy", 1)` para que `express-rate-limit` lea bien la IP.
- Puertos del host configurables por `.env` (`WEB_PORT_HOST`, `API_PORT_HOST`...).
- **No editar a mano en el servidor**: cambios en local → commit → push → `git pull`.

## Limitaciones conocidas (resumen)
- El chat por SQL necesita un modelo capaz (`qwen3:14b`); con 3b/7b el SQL falla bastante más. Un modelo pequeño también mezcla campos al extraer facturas — mitigado con `reconciliarPartes`/`resolverDireccion` y la **edición manual** en la página Facturas. Detalle y resto de limitaciones en `NOTAS.md`.
- Tipos permitidos: PDF, DOCX, XLSX, TXT, CSV, JPEG, PNG, WEBP. Máx 50 MB. Subida: 1 archivo/petición (paralelas en el front).
- **Carpetas compartidas / chat por rol (Fase 3):**
  - La capacidad **`chat`** gobierna el acceso al chatbot entero: sin ella, `POST /api/chat` responde 403 y el front oculta el enlace/ruta `/inicio`. Un miembro **sin ningún rol** (o con roles que no incluyen `chat`) **no ve el chatbot** — el admin debe darle un rol con la capacidad `chat`. (Quitar `chat` a un rol surte efecto en la siguiente petición del backend y al recargar el front, sin re-loguear.) La capacidad **`busqueda`** decide si el chat puede leer el **contenido** de los documentos (no solo nombres y carpetas).
  - La capacidad **`gestion_archivos`** gobierna **todo lo que modifica** archivos y carpetas, en el espacio personal y en el compartido: subir, mover, copiar, renombrar, borrar, papelera y descripción manual. Se exige en las rutas de `/api/archivos` y `/api/compartido` que modifican (`exigirGestionArchivos` → 403). El chat no la necesita: es de solo lectura. **Ver y descargar NO la requieren**: sin ella el explorador queda en solo lectura (el front oculta los botones con `auth.puedeGestionArchivos()`, pero la frontera real es el backend). El acceso a una carpeta compartida lo sigue dando el **rol**; esta capacidad decide si además se puede modificar dentro. La migración `1778000000000` se la añadió a los roles que ya existían, porque antes la casilla no se comprobaba.
  - Cada espacio tiene su **propio buscador acotado**: el de **Mis archivos** (`/api/archivos/buscar`) busca **solo** en lo personal, y el de **cada carpeta compartida** (`GET /api/compartido/:id/buscar`, mismo `ExploradorComponent`) **solo** dentro de esa carpeta. El **chat** ve lo personal y las carpetas compartidas accesibles.
  - Facturas dentro de carpetas compartidas: se extrae su texto pero **no** se auto-escanean a la analítica (no se atribuyen a un usuario).
  - Archivos compartidos: **no van a la papelera** (borrado directo, afecta a todos los del rol).
  - El explorador de una carpeta compartida usa el **mismo `ExploradorComponent`** que "Mis archivos" (fuente = adaptador de `CompartidoService`): subcarpetas persistidas (incl. vacías, tabla `carpeta_compartida_carpetas`), mover/renombrar/copiar archivos y carpetas, drag&drop, selección múltiple, paginación y descarga zip. Se desactivan las acciones de IA (describir/escanear); los borrados son definitivos (no papelera).

## Preferencias de trabajo (Vlad)
- **Solo pedir confirmación para decisiones de diseño**, no para llamadas de herramienta rutinarias.
