# AKX Cloud — Frontend

Interfaz web (Angular) para CloudDrive: chatbot IA, gestión de archivos con carpetas y
papelera, autenticación y perfil.

## Stack

- **Angular** (componentes *standalone*, *signals*, rutas con *lazy loading*)
- **SCSS propio** con variables de tema (claro/oscuro), sin librerías de UI
- `HttpClient` + **interceptor** (Bearer token) + **guard** de rutas privadas

## Arranque

```bash
npm install
npm start        # ng serve con proxy → http://localhost:4200
```

Requiere el backend en `http://localhost:3000` (`docker compose up -d` desde la raíz del
monorepo). El dev server usa `proxy.conf.json` para reenviar `/api/**` al backend (mismo
origen en el navegador → sin CORS y con las cabeceras de paginación `X-Total-*`).

## Flujo

```
Login (JWT en localStorage)
  → Shell (navbar, protegido por guard)
      ├─ Inicio   → Chat con el asistente IA
      ├─ Archivos → subir, carpetas, mover, renombrar, papelera, búsqueda por contenido
      ├─ Papelera → restaurar / borrar definitivo / vaciar
      └─ Perfil   → nombre, avatar, contraseña
```

Cada petición pasa por el **interceptor**, que añade `Authorization: Bearer <token>`.
Si el backend responde `401` (sesión caducada), el interceptor cierra sesión y manda al
login. Las rutas bajo el Shell están protegidas por el **guard** (sin token → login).

## Cómo funcionan las partes clave

### Estado y sesión (`core/`)
- `auth.service`: login/registro, guarda token y usuario en `localStorage`, expone el
  usuario actual como *signal* reactiva (para la navbar, etc.).
- `archivos.service` / `chat.service`: llaman a la API. El historial del chat vive en el
  servicio (singleton) y se persiste en `localStorage`, así sobrevive a recargas y a
  cambiar de página.

### Chat (`pages/inicio`)
Envía la conversación a `/api/chat` y muestra la respuesta. Detalles importantes para
que el asistente sea fiable:

- Como contexto se envían **solo los mensajes del usuario** (no las respuestas del bot,
  últimos 8). Reenviar sus propias respuestas narradas le "enseñaba" a fingir acciones
  sin llamar a las herramientas, y fallaba a partir del 2º mensaje. El backend, a su vez,
  solo usa el **último** mensaje de ese historial (cada orden se trata como independiente).
- La **confirmación real** de una acción son las líneas `✓` que el componente añade a
  partir del array `acciones` que devuelve el backend (solo aparecen cuando una
  herramienta se ejecutó de verdad); el texto del bot solo acompaña.

### Archivos (`pages/archivos`)
Vista de carpetas + archivos con navegación por rutas, subida, drag & drop para
mover/copiar, renombrar y enviar a la papelera. Las carpetas vacías se mantienen como
metadata en el backend. Incluye un **buscador por contenido** (RAG): llama a
`GET /api/archivos/buscar?q=` y muestra los documentos relevantes con el fragmento que
coincide; al hacer clic lleva a la carpeta del archivo. El menú contextual de un PDF/
imagen tiene **"Escanear factura"**, que abre un modal (con pista opcional) y llama a
`POST /api/facturas/escanear` (OCR + extracción de datos).

### Tema y UI (`shared/`, `layout/`)
Tema claro/oscuro con variables CSS, toasts de éxito/error, pipe de tamaño de fichero y
helper de mensajes de error. UI propia sin frameworks de componentes.

## Estructura

```
src/app/
  core/        auth, archivos, chat, theme, toast (servicios), interceptor, guard, modelos
  layout/      shell con navbar AKX Cloud
  pages/       login, inicio (chat), archivos, papelera, perfil
  shared/      pipe de tamaño, helper de errores, toasts
  environments/environment.ts   apiUrl (vacío en dev → usa el proxy)
```

## Build de producción

```bash
npm run build    # genera dist/akx-cloud-frontend/browser
```

## Despliegue con Docker (recomendado)

Este directorio (`frontend/`) vive dentro del monorepo `akx-cloud-project`, junto a
`backend/`. Incluye un `Dockerfile` (build de Angular → **nginx**) y `nginx.conf` que
sirve la SPA y hace de **proxy de `/api`** hacia el backend (mismo origen, sin CORS).
Está integrado en el `docker-compose.yml` de la raíz del monorepo como servicio `web`
(puerto 80), así que `environment.apiUrl` se queda **vacío** (las peticiones van a
`/api` y nginx las reenvía).

Para levantarlo, desde la raíz del monorepo:

```bash
docker compose up -d --build   # db + minio + api + web (incluye este frontend)
```

Acceso: `http://IP-del-servidor` (puerto 80). Para desarrollo local del front sigue
usándose `npm start` (`ng serve` en :4200), que tiene hot-reload.
