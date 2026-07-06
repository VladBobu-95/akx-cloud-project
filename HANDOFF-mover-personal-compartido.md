# HANDOFF — Mover/Copiar entre Personal ↔ Compartido

> Estado: **EN PROGRESO, nada implementado todavía**. Esto es el diseño ya acordado
> + el análisis del código. Retomar desde aquí. (Escrito 2026-07-06.)

## Qué pide Vlad
1. **El drag entre Personal y Compartido debe MOVER, no copiar** (en ambos sentidos).
2. **"Mover a…" y "Copiar en…" deben funcionar entre Personal y Compartido**, ambos sentidos.

## Decisiones de diseño YA confirmadas por Vlad
- **Mover de verdad**: al mover un compartido → personal, el original **desaparece del
  compartido para TODOS los del rol** (almacenamiento único). Confirmado: sí, mover de verdad.
- **Destino compartido = selector**: al mover/copiar personal → compartido, como "Compartido"
  son varias carpetas por rol, se abre un **selector de carpeta compartida** (y sus subcarpetas).

## Estado actual del código (diagnóstico)
- **Compartido → Personal**: existe pero es **COPIA** (`copiarAPersonal`). Drag sobre el botón
  "Personales" (`[data-drop-personal]`), menú "Copiar a Mis archivos", y opción externa en
  "Copiar en…". → Hay que **cambiar el drag a MOVER** (dejar la copia solo en el menú "Copiar en…").
- **Personal → Compartido**: **no existe nada** (ni endpoint ni destino externo en el explorador personal).
- **"Mover a…"** nunca ofrece destinos cross-space en ningún sentido.

## Arquitectura relevante
- `frontend/.../archivos/archivos.ts|html`: página con toggle Personales/Compartido. Aloja
  `<app-explorador [datos]="svc">` (personal) y `<app-compartido>`. Los botones toggle están aquí;
  "Personales" tiene `data-drop-personal` (zona de drop).
- `frontend/.../archivos/explorador.ts|html`: **el explorador reutilizable** (drag&drop por punteros,
  menú contextual, modales "Mover a…"/"Copiar en…", selección múltiple). Toda la maquinaria externa
  vive aquí: `opciones.destinoExterno`, output `copiarAExterno`, `detectarDestinoExterno`,
  `emitirExportacion`, `construirExportacion`, `PeticionExportar`.
- `frontend/.../archivos/fuente.ts`: interfaz `FuenteArchivos`, `OpcionesExplorador`, `PeticionExportar`.
- `frontend/.../archivos/compartido.ts`: `FuenteCompartida` (adaptador) + `CompartidoComponent`
  (recibe `copiarAExterno` → `copiarAPersonal`). Ya precarga `carpetasPersonales` para subcarpetas.
- `frontend/.../core/compartido.service.ts`: llamadas HTTP.
- `backend/.../services/compartido.service.ts`: lógica. `backend/.../controllers/compartido.controller.ts`,
  `backend/.../routes/compartido.routes.ts`.

## Plan de implementación (los TODOs)

### 1) Backend — `compartido.service.ts` (3 funciones nuevas)
Clave importante: **en MOVER se conserva la misma `claveMinio`** (la reconciliación casa por clave
exacta, no por prefijo — verificado en `reconciliacion.service.ts`). No hace falta copiar el binario.

- **`moverPersonalACompartido(archivoId, usuarioId, carpetaCompartidaId, carpetaDestino?)`**
  - Cargar archivo personal (propietario == usuario, `carpetaCompartidaId` null). `verificarAcceso` a la CC.
  - Dedup por (CC, hash) con `buscarCompartidoPorHash`: si ya existe → borrar el original personal
    (binario + fila) y devolver el existente `{duplicado:true}`.
  - Si no: reasignar en sitio → `carpetaCompartidaId = X`, `carpeta = normalizarCarpeta(destino)`,
    conservar `propietario` (autor), **misma claveMinio**.
  - Fragmentos RAG: `UPDATE fragmentos SET "carpetaCompartidaId"=$X WHERE "archivoId"=$id`.
  - Facturas: **borrar** las filas Factura del archivo (`facturaRepo.delete({ archivo:{id} })`) para que
    salga de la analítica personal (coherente con "las facturas compartidas no van a analítica"). La
    analítica son queries en vivo, no hay que regenerar agregados.
  - `registrarEvento(X, usuarioId, "subir", { objeto:nombre, ruta:destino, detalle:"movido desde Mis archivos" })`.

- **`moverCompartidoAPersonal(archivoId, usuarioId, carpetaDestino?)`**
  - `cargarCompartidoConAcceso`. Dedup por hash contra personal vivo (propietario==usuario,
    carpetaCompartidaId null): si ya lo tienes → borrar el compartido (binario+fila, afecta a todos) y
    devolver el personal existente `{duplicado:true}`.
  - Si no: reasignar → `carpetaCompartidaId = null`, `carpeta = destino`, `propietario = usuarioId`,
    misma claveMinio.
  - Fragmentos: `UPDATE fragmentos SET "carpetaCompartidaId"=NULL, "propietarioId"=$user WHERE "archivoId"=$id`.
  - Persistir carpeta personal destino (`crearCarpeta(usuarioId, destino)` best-effort).
  - Auto-escaneo factura como personal: si `esArchivoFactura` → `marcarPendiente` + `encolarTarea({tipo:"autoescanear",...})`
    (igual que `copiarCompartidoAPersonal`).
  - `registrarEvento(ccOrigen, usuarioId, "eliminar", { objeto:nombre, detalle:"movido a Mis archivos" })`
    (se va del compartido). Reutilizar enum existente "eliminar" (no crear valores nuevos = evita migración).

- **`copiarPersonalACompartido(archivoId, usuarioId, carpetaCompartidaId, carpetaDestino?)`**
  - Como `copiarArchivoCompartido` pero origen personal. Dedup (CC, hash) → devolver existente.
  - `copyObject` a clave `compartido/${ccId}/...` nueva, crear Archivo con carpetaCompartidaId,
    propietario=user, nombre exacto (append "(copia)" si choca en destino).
  - Copiar fragmentos con carpetaCompartidaId set (INSERT ... SELECT como en `copiarArchivoCompartido`).
  - `registrarEvento(X,... "copiar", {detalle:"desde Mis archivos"})`.

Reutilizar: `calcularHashSha256`, `crearCarpeta`, `esArchivoFactura`, `marcarPendiente`,
`encolarTarea/P_ALTA/P_IMG_SCAN` (ya importados). `Factura` FK a Archivo es `CASCADE nullable`.

### 2) Backend — controller + rutas
Rutas nuevas (respetar orden: `/archivo/:archivoId/*` antes que `/:id/*`):
- `POST /api/compartido/archivo/:archivoId/mover-a-personal`  { carpeta? }  → moverCompartidoAPersonal
- `POST /api/compartido/:id/mover-desde-personal`  { archivoId, carpeta? }  → moverPersonalACompartido
- `POST /api/compartido/:id/copiar-desde-personal` { archivoId, carpeta? }  → copiarPersonalACompartido
- (ya existe) `POST /api/compartido/archivo/:archivoId/copiar-a-personal`

### 3) Frontend — `compartido.service.ts`
Añadir métodos: `moverAPersonal(archivoId, carpeta)`, `moverDesdePersonal(ccId, archivoId, carpeta)`,
`copiarDesdePersonal(ccId, archivoId, carpeta)`.

### 4) Frontend — generalizar `destinoExterno` en `fuente.ts` + `explorador.ts`
Nuevo shape (soporta ambos sentidos y varias carpetas destino):
```ts
destinoExterno?: {
  etiqueta: string;          // "Compartido" | "Mis archivos"
  dropAttr: string;          // 'data-drop-compartido' | 'data-drop-personal'
  destinos: { id: string | null; etiqueta: string; carpetas?: string[] }[];
};
```
- id = ccId (personal→compartido) o null (compartido→personal = Mis archivos).
- `PeticionExportar` += `destinoId: string | null`.
- Dos outputs: `moverAExterno` (drag + "Mover a…" externo) y `copiarAExterno` ("Copiar en…" externo + menú + bulk).
- `detectarDestinoExterno` usa `[${opciones.destinoExterno.dropAttr}]` en vez de fijo `[data-drop-personal]`.

### 5) Frontend — drag = MOVER + selector
- En `onPointerUp`, si se suelta sobre la zona externa:
  - `destinos.length === 1` (compartido→personal): emitir **moverAExterno** directo a destinos[0] raíz.
  - `destinos.length > 1` (personal→compartido): guardar items pendientes y **abrir modal selector**
    de carpetas compartidas; al elegir → emitir moverAExterno. (Subcarpetas: cargar on-demand al elegir
    carpeta, o v1 solo raíz de cada compartida.)
- Añadir carpetas compartidas como destinos en "Mover a…" (MOVER) y "Copiar en…" (COPIAR) del explorador personal.

### 6) Frontend — cablear contenedores
- `archivos.html`: añadir `data-drop-compartido` al botón "Compartido". Pasar `destinoExterno` (lista de
  carpetas compartidas) al `<app-explorador>` personal, y manejar `(moverAExterno)`/`(copiarAExterno)`.
  → `ArchivosPage` debe cargar `CompartidoService.accesibles()` para poblar los destinos.
- `compartido.ts`: cambiar el manejo del drag para que use **moverAPersonal** (mover), manteniendo
  `copiarAPersonal` para el "Copiar en…"/menú copia. Ajustar `destinoExterno` al nuevo shape.

### 7) Verificar build backend + frontend.

## Notas / riesgos
- No crear valores nuevos en el enum `AccionCompartida` (evita migración) — reutilizar "subir"/"eliminar"/"copiar".
- `moverCompartidoAPersonal` es destructivo para el rol: bien confirmado por Vlad.
- Dedup en move: si el destino ya tiene el contenido, el "move" se resuelve borrando el origen y
  devolviendo el existente con `duplicado:true` (mismos toasts que hoy).
- Preferencia Vlad: solo pedir confirmación para decisiones de diseño (ya hechas). Implementar directo.
