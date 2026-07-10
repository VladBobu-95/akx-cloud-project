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

Los componentes tienen `.ts` + `.html` + `.scss` separados (salvo los pequeños de
`core/`/`shared/`, que son inline). Todo standalone, sin NgModule.

```
src/
  app/
    core/
      archivos.service.ts    ← CRUD archivos, carpetas, búsqueda semántica, escanear factura, describir imagen
      compartido.service.ts  ← Carpetas compartidas por rol (uso miembro + gestión admin + logs)
      facturas.service.ts    ← Listado/detalle/edición de facturas, reclasificar
      equipo.service.ts      ← Admin: miembros, roles configurables, datos de empresa (CIF)
      plataforma.service.ts  ← Superadmin: alta/edición/borrado de empresas
      auth.service.ts        ← Login (sin registro público), token en localStorage, signals usuario + capacidades
      auth.guard.ts          ← Redirige a /login si no hay token
      admin.guard.ts / superadmin.guard.ts ← Gatean /equipo y /plataforma por rol
      chat.guard.ts          ← Bloquea /inicio si el rol no tiene la capacidad `chat`
      auth.interceptor.ts    ← Añade Authorization: Bearer <token> a todas las peticiones
      chat.service.ts        ← Envía mensajes al bot, historial en signal + localStorage
      models.ts              ← Interfaces: Usuario, Empresa, Rol, CarpetaCompartida, Miembro, Archivo, FilaFactura, FacturaDetalle...
      theme.service.ts       ← Toggle dark mode (clase body.dark)
      toast.service.ts       ← Notificaciones toast (signal de cola)
    layout/
      shell.ts               ← Navbar (logo + nav según rol + avatar + cerrar sesión)
    pages/
      login/login.ts         ← Iniciar sesión (no hay auto-registro)
      inicio/inicio.ts       ← Chat con el asistente IA
      archivos/              ← Explorador: archivos.ts (toggle Personales/Compartido) + explorador.ts (árbol/tabla/drag&drop, reutilizado) + compartido.ts + fuente.ts (adaptador de datos) + rutas.util.ts
      facturas/facturas.ts   ← Tabla venta/compra/sin clasificar + editor de factura
      papelera/papelera.ts   ← Papelera con restaurar/borrar permanente/vaciar
      perfil/perfil.ts       ← Editar nombre, avatar y (admin) CIF de la empresa
      equipo/equipo.ts       ← Admin: miembros, roles, carpetas compartidas + registro de actividad
      plataforma/plataforma.ts ← Superadmin: gestión de empresas
    shared/
      file-size.pipe.ts      ← Formatea bytes a KB/MB/GB
      tipos-archivo.ts       ← Extensiones/tamaño permitidos (criba en cliente antes de subir)
      password-input.component.ts ← Input de contraseña con toggle (ControlValueAccessor)
      toasts.component.ts    ← Renderiza la cola de toasts
      errores.ts             ← mensajeError(err): extrae string legible de HttpErrorResponse
    app.ts                   ← Componente raíz
    app.html                 ← Template raíz (router-outlet + toasts)
    app.routes.ts            ← Rutas: /login, /inicio, /archivos, /facturas, /papelera, /perfil, /equipo, /plataforma
    app.config.ts            ← provideRouter, provideHttpClient con interceptor
  environments/
    environment.ts           ← { apiUrl: '' } (vacío → nginx proxy en Docker; localhost:3000 en dev)
  styles.scss                ← Tema global: CSS vars verde/blanco + modo oscuro
  index.html
```

---

## Páginas principales

### `/login`
- Solo iniciar sesión: **no hay auto-registro** (multi-tenant; el superadmin crea empresas
  y su admin, el admin crea miembros)
- Toggle para mostrar/ocultar contraseña (`password-input.component`)

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
- **Menú contextual** (clic derecho): abrir, añadir descripción, descargar, copiar, renombrar, mover, borrar
- **Visor de .md**: renderiza markdown con `marked` en un modal inline
- **Selección múltiple**: checkbox por fila + barra de acciones bulk (copiar/mover/borrar);
  al borrar carpeta+archivos seleccionados a la vez, se espera a que el borrado de la
  carpeta termine en el servidor antes de refrescar (si no, podía "reaparecer" hasta
  repetir la acción una segunda vez)
- **Búsqueda semántica RAG**: campo + botón que llama `/api/archivos/buscar`
- **Columna "Estado"** (iconos, refresco con polling cada 3s mientras haya algo en
  proceso): `spinner + "Escaneando"` mientras se procesa, `✓` verde cuando terminó
  (factura o no, ambos = "procesado"; no es clicable), `✕` rojo si hubo error; en blanco
  si no aplica (txt/docx)
- **Añadir descripción**: sustituye al "Escanear" manual (ya innecesario: todo se escanea/
  indexa solo al subir). Modal con textarea que se guarda vía `describirArchivo`
  (`PATCH /api/archivos/:id/descripcion`) y se reindexa para el buscador por contenido —
  útil para que una foto sea encontrable por una descripción a mano

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
- `usuario` signal (del token decodificado) + capacidades del rol (para ocultar lo que no puede hacer)
- `login()`, `logout()` (borra token + navega a `/login`) — **no hay `registrar()`**
- `puedeChat()` y demás helpers de capacidad; refresca el perfil (`GET /api/auth/perfil`) al arrancar

### Otros servicios
- `CompartidoService` — carpetas compartidas: uso (miembro), gestión (admin) y registro de actividad (`logs`)
- `FacturasService` — listado paginado, detalle, edición manual y reclasificar venta/compra
- `EquipoService` (admin) / `PlataformaService` (superadmin) — gestión de equipo y de empresas

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
- **El chat sí muestra `acciones`**: `inicio.ts` concatena el array `acciones` de la API al texto de la respuesta como líneas `✓ ...`.
- **Consciente del rol (RBAC)**: las capacidades del usuario (del login / `GET /api/auth/perfil`) ocultan lo que su rol no puede hacer; el `chatGuard` bloquea `/inicio` sin la capacidad `chat`; `adminGuard`/`superadminGuard` gatean `/equipo` y `/plataforma`.
- **El explorador es un único componente reutilizado** (`explorador.ts`): sirve tanto "Mis archivos" (personal) como cada carpeta compartida, cambiando solo la fuente de datos (`fuente.ts`).
- **archivos.ts no usa paginación**: carga todos los archivos en memoria para construir el árbol de carpetas localmente. Si un usuario tiene miles de archivos, podría ser lento.
- **Subida de archivos**: un archivo a la vez por petición; si se seleccionan varios, se hacen peticiones paralelas con `forkJoin`.
