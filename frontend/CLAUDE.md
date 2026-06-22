# AKX Cloud — Frontend (akx-cloud-frontend)

## Resumen

SPA Angular 22 para la app de almacenamiento en la nube AKX Cloud. Se sirve con nginx dentro de Docker y hace proxy de `/api` hacia el contenedor `api`.

**Repo:** `https://github.com/VladBobu-95/akx-cloud-frontend`

El backend está en el repo `cloud-project` (carpeta hermana). Ver `cloud-project/CLAUDE.md` para la arquitectura completa y cómo arrancar Docker.

---

## Stack

| | |
|---|---|
| Framework | Angular 22 (standalone components, signals) |
| Estado | Angular signals (`signal`, `computed`) — sin NgRx |
| HTTP | `HttpClient` con interceptor de JWT |
| Estilos | SCSS inline en cada componente + `styles.scss` global |
| Markdown | `marked` v18 (para renderizar respuestas del chat y .md) |
| Tema | CSS custom properties (verde/blanco + modo oscuro) |
| Build | Angular CLI / esbuild |
| Servidor | nginx (en Docker) |

---

## Arrancar en desarrollo

```bash
npm install
npm start        # ng serve → http://localhost:4200
```

El `proxy.conf.json` redirige `/api` a `http://localhost:3000` (API local).
Para que funcione hay que tener el backend corriendo (`docker compose up -d` en `cloud-project`).

---

## Estructura

```
src/
  app/
    core/
      archivos.service.ts   ← CRUD archivos, carpetas, búsqueda semántica, escanear factura, describir imagen
      auth.service.ts       ← Login, registro, token en localStorage, signal usuario
      auth.guard.ts         ← Redirige a /login si no hay token
      auth.interceptor.ts   ← Añade Authorization: Bearer <token> a todas las peticiones
      chat.service.ts       ← Envía mensajes al bot, historial en signal + localStorage
      models.ts             ← Interfaces: Usuario, Archivo, ListaArchivos, ResultadoBusqueda
      theme.service.ts      ← Toggle dark mode (clase body.dark)
      toast.service.ts      ← Notificaciones toast (signal de cola)
    layout/
      shell.ts              ← Navbar (logo + nav + avatar + cerrar sesión)
    pages/
      login/login.ts        ← Login + registro en una sola vista (tabs)
      inicio/inicio.ts      ← Chat con el asistente IA
      archivos/archivos.ts  ← Explorador de archivos (tabla + carpetas + drag&drop)
      papelera/papelera.ts  ← Papelera con restaurar/borrar permanente/vaciar
      perfil/perfil.ts      ← Editar nombre y avatar
    shared/
      file-size.pipe.ts     ← Formatea bytes a KB/MB/GB
      toasts.component.ts   ← Renderiza la cola de toasts
      errores.ts            ← mensajeError(err): extrae string legible de HttpErrorResponse
    app.ts                  ← Componente raíz
    app.html                ← Template raíz (router-outlet + toasts)
    app.routes.ts           ← Rutas: /login, /inicio, /archivos, /papelera, /perfil
    app.config.ts           ← provideRouter, provideHttpClient con interceptor
  environments/
    environment.ts          ← { apiUrl: '' } (vacío → nginx proxy en Docker; localhost:3000 en dev)
  styles.scss               ← Tema global: CSS vars verde/blanco + modo oscuro
  index.html
```

---

## Páginas principales

### `/login`
- Tabs "Iniciar sesión" / "Crear cuenta" en un único componente
- Toggle para mostrar/ocultar contraseña

### `/inicio` — Chat
- Historial de mensajes en signal, persistido en `localStorage` (clave `akx_chat`)
- Envía solo los mensajes del **usuario** (últimos 8, no las respuestas del bot) como
  contexto; el backend a su vez solo usa el último de esos
- Respuestas del bot renderizadas como **markdown real** con `marked` (`renderBot()` →
  `[innerHTML]`, `breaks: true`), igual que el visor de `.md` del explorador — necesario
  para que las tablas de `ventas_top`/`totales_facturas`/`clientes_top` se vean
  formateadas. Los mensajes del usuario se siguen mostrando tal cual (texto plano)
- El campo `acciones` se concatena al texto de la respuesta como líneas `✓ ...`

### `/archivos` — Explorador
Componente más complejo. Características:
- **Árbol de carpetas en cliente**: carga TODOS los archivos y deriva el árbol localmente
- **Carpetas persistidas en BD** (`/api/archivos/carpetas`): permite carpetas vacías
- **Drag & drop** propio (eventos `pointer`, no HTML5 DnD) para mover archivos/carpetas
- **Menú contextual** (clic derecho): abrir, escanear factura, descargar, copiar, renombrar, mover, borrar
- **Visor de .md**: renderiza markdown con `marked` en un modal inline
- **Selección múltiple**: checkbox por fila + barra de acciones bulk (copiar/mover/borrar);
  al borrar carpeta+archivos seleccionados a la vez, se espera a que el borrado de la
  carpeta termine en el servidor antes de refrescar (si no, podía "reaparecer" hasta
  repetir la acción una segunda vez)
- **Búsqueda semántica RAG**: campo + botón que llama `/api/archivos/buscar`
- **Modal escanear factura**: botón "Escanear factura" en el menú contextual de archivos
  PDF/imagen, con pista opcional (ya se envía correctamente al backend)
- **Modal describir imagen**: tras subir una o varias imágenes, pregunta "¿Qué es esta
  imagen?" (obligatorio, sin omitir, una por una; no hay fallback de IA si el OCR
  automático no encuentra texto real); lo escrito se guarda como el contenido del
  archivo (`describirArchivo`) para que "muéstrame"/la búsqueda semántica lo encuentren

### `/papelera`
- Lista archivos eliminados con fecha de borrado
- Restaurar individual, borrar permanente, vaciar toda la papelera

### `/perfil`
- Editar nombre y URL de avatar

---

## Servicios clave

### `ArchivosService`
- `listarTodos()`: pagina automáticamente hasta traer todos los archivos (para construir el árbol)
- `listarCarpetas()`: lista carpetas persistidas en BD
- `crearCarpetaApi(ruta)`, `reubicarCarpetaApi(origen, destino)`, `eliminarCarpetaApi(ruta)`
- `subir(file, carpeta)`: multipart a `/api/archivos/subir`
- `descargar(id)`: GET con `responseType: 'blob'` (la API hace streaming del binario, no es un redirect a MinIO)
- `descargarCarpeta(ruta)`: descarga .zip
- `escanearFactura(archivoId, pista?)`: POST a `/api/facturas/escanear`
- `describirArchivo(archivoId, descripcion)`: PATCH a `/api/archivos/:id/descripcion`
- `buscarSemantica(q)`: GET a `/api/archivos/buscar?q=...`

### `ChatService`
- `mensajes` signal — historial en memoria + localStorage
- `enviar(mensajes)`: POST a `/api/chat` con el historial completo
- El componente `inicio.ts` añade los mensajes al signal local y luego persiste

### `AuthService`
- Token en `localStorage` (clave `akx_token`)
- `usuario` signal (computed del token decodificado)
- `login()`, `registrar()`, `logout()` (borra token + navega a `/login`)

---

## Tema y estilos

`styles.scss` define CSS custom properties:
```scss
--green: #16a34a
--green-dark: #11823b
--green-soft: #e9f9ef   (fondos suaves, hover)
--bg, --surface, --text, --muted, --border, --danger
--radius: 12px
--shadow, --shadow-sm
```

Modo oscuro: clase `body.dark` sobreescribe las variables. `ThemeService` la gestiona.

Clases CSS globales (definidas en cada componente vía `styles: [...]`):
- `.btn`, `.btn-primary`, `.btn-outline`, `.btn-ghost`, `.btn-danger`, `.btn-sm`
- `.card` (fondo blanco, borde, sombra, border-radius)
- `.input` (campo de texto)
- `.table` (tabla con cabecera gris)
- `.modal-backdrop` + `.modal` (overlay oscuro + card centrado)
- `.empty` (estado vacío centrado)
- `.muted` (texto gris)

---

## Notas importantes

- **No hay NgRx ni stores**: el estado se gestiona con signals de Angular 22.
- **Standalone components**: todos los componentes usan `imports: [...]` en lugar de NgModule.
- **El chat no muestra `acciones`**: el array de acciones que devuelve la API (ej: "Factura escaneada (FAC-001): 3 líneas") no se renderiza en la UI actual. Si se quiere mostrar, hay que añadirlo en `inicio.ts`.
- **archivos.ts no usa paginación**: carga todos los archivos en memoria para construir el árbol de carpetas localmente. Si un usuario tiene miles de archivos, podría ser lento.
- **Subida de archivos**: un archivo a la vez por petición; si se seleccionan varios, se hacen peticiones paralelas con `forkJoin`.
