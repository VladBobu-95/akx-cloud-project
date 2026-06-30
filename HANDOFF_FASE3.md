# Traspaso — Fase 3 (carpetas compartidas + chat por rol)

> Estado a 2026-06-30. Plan completo en `~/.claude/plans/` (no viaja); resumen del
> proyecto SaaS: F1 (multi-tenant+superadmin) y F2 (equipo+roles+capacidades) están
> **hechas, probadas y desplegadas**. Esto es lo de la **Fase 3**.

## ⚠️ Antes de nada
- **Haz `git add -A && git commit && git push`** desde este PC para tener todo el código
  en el otro. Estás en la rama `main`.
- En el otro PC, tras `git pull`: levanta infra y rebuild (ver "Desplegar" abajo).

## Qué está HECHO en Fase 3 (código escrito)
**Backend — `npx tsc --noEmit` PASA (compila):**
- Entidad `backend/src/entities/CarpetaCompartida.ts` + registrada en `config/database.ts`.
- `Archivo.carpetaCompartidaId` (nullable) y columna `carpetaCompartidaId` en `fragmentos`.
- Migración `backend/src/migrations/1771000000000-AgregarCompartido.ts` (tablas
  `carpetas_compartidas`, `carpeta_compartida_roles`, columnas + FKs).
- `services/compartido.service.ts`: CRUD admin, `carpetasAccesibles`/`idsCompartidasAccesibles`,
  `listarArchivosCompartidos`, `subirCompartido` (dedup por hash), `descargarCompartido`,
  `eliminarCompartido`.
- `controllers/compartido.controller.ts` + `routes/compartido.routes.ts` montado en `app.ts`
  como `/api/compartido` (admin: `/admin*`; miembro: `/`, `/:id/archivos`, `/:id/subir`,
  `/archivo/:archivoId/descargar`, `DELETE /archivo/:archivoId`).
- RAG (`rag.service.ts`): `reindexarFragmentos` guarda `carpetaCompartidaId`;
  `buscarSemantica(usuarioId, q, k, compartidasAccesibles[])` incluye lo compartido accesible.
  `controllers/archivos.controller.ts` (ctrlBuscarSemantica) ya le pasa los accesibles.
- Worker (`tareas.service.ts`): NO auto-escanea facturas en carpetas compartidas.
- **Chat por rol** (`chat.service.ts`): mapa `TOOL_CAPACIDAD`, guard en `ejecutarTool`
  (5º arg `capacidades`), filtro `toolsPermitidas` que ve el modelo, `llamarOllama(..., tools)`,
  `capacidades`/`puedeFacturas` al inicio de `chatear`, y pre-flights de facturas gateados
  con `puedeFacturas`. Capacidad la calcula `capacidadesDe()` de `equipo.service.ts`.

**Frontend — build NO verificado todavía (ÚLTIMO build quedó sin ejecutar):**
- `core/models.ts`: `CarpetaCompartida`.
- `core/compartido.service.ts` (admin + miembro).
- `pages/archivos/compartido.ts`: componente `app-compartido` (vista compartida: tarjetas de
  carpeta, navegación, subir/descargar/borrar).
- `pages/archivos/archivos.*`: toggle **Personales/Compartido** (signal `ambito`), envuelve
  el explorador personal en `@if (ambito()==='personal')` y muestra `<app-compartido/>` en
  compartido. Estilo `.ambito-toggle` en `archivos.scss`.
- `pages/equipo/equipo.*`: tercera pestaña **Compartido** (admin: crear/editar/borrar carpetas
  compartidas + asignar roles). Modal añadido.

## Qué FALTA (orden recomendado)
1. **Compilar frontend y arreglar errores de plantilla** (lo más probable que falle por mis
   ediciones de `archivos.html`/`equipo.html`):
   `cd frontend && npx ng build --configuration development`
   - Revisar que los `@if` del toggle en `archivos.html` cierran bien (envolví líneas ~9–212
     en `@if (ambito()==='personal'){ … }` y añadí el bloque compartido antes del `</div>`
     que cierra `.page-archivos`).
   - Revisar el bloque "CARPETAS COMPARTIDAS" y el modal nuevo en `equipo.html`.
2. **Tests backend**: `cd backend && npm test`
   - Confirmar que NO se rompió `confirmacion.test.ts` (usa el chat; un miembro sin roles
     tiene capacidades vacías — el flujo de "vaciar papelera" NO requiere capacidad, debe
     seguir pasando).
   - Añadir `tests/compartido.test.ts`: admin crea carpeta compartida con rol → miembro con
     ese rol la ve (`GET /api/compartido`), sube/lista/descarga/borra; miembro sin el rol NO
     la ve (403 al operar); aislamiento entre empresas.
   - Añadir test de **chat por rol**: miembro sin capacidad `facturas` → `POST /api/chat`
     "lista mis facturas" responde que no está disponible; con `facturas` sí. (Usa helpers de
     `tests/helpers.ts`: `crearUsuario(email,{rol/empresaId})`. Para dar capacidad, crear un
     `Rol` con capacidad y asignarlo, o usar un admin que tiene todas.)
3. **Docs**: actualizar `CLAUDE.md` (entidad `CarpetaCompartida`; rutas `/api/compartido`;
   schema `carpetas_compartidas`/`carpeta_compartida_roles` + `archivos.carpetaCompartidaId`,
   `fragmentos.carpetaCompartidaId`; nota del chat consciente del rol). Actualizar también la
   sección "Limitaciones" (ver abajo). Borrar este `HANDOFF_FASE3.md` al terminar.
4. **Desplegar** (corre las migraciones `AgregarRoles` 1770 si no estaba y `AgregarCompartido`
   1771): `docker compose build api web && docker compose up -d api web`.
5. **Verificar end-to-end** (ver "Verificación").

## Desplegar / arrancar (recordatorio)
- Infra: `docker compose up -d db minio ollama adminer` (ya suele estar levantada).
- Tras cambios de código: `docker compose build api web && docker compose up -d api web`.
- Tras desplegar, en el navegador **Ctrl+F5** (la caché ya nos dio un susto en F1/F2).
- Superadmin actual: `vlad@gmail.com` / `12345678`. Hay empresas creadas (admin `boby@gmail.com`).

## Verificación de Fase 3 (manual)
1. Admin (boby@gmail.com) → Equipo → pestaña **Compartido** → crea "Contabilidad" y dale el
   rol contabilidad. Crea un miembro con ese rol y otro sin él.
2. Login del miembro CON rol → Mis archivos → toggle **Compartido** → ve "Contabilidad",
   entra, sube un archivo. Otro miembro con el rol lo ve; el que NO tiene el rol no ve la
   carpeta.
3. Búsqueda semántica (buscador de Mis archivos) encuentra el archivo compartido para quien
   tiene acceso.
4. **Chat por rol**: miembro de mantenimiento (sin capacidad `facturas`) escribe "lista mis
   facturas" → el bot responde que no está disponible para su rol. Un miembro con `facturas`
   sí las lista.

## Limitaciones asumidas (dejar anotadas en CLAUDE.md)
- Capacidades del chat: **gestión básica de archivos personales siempre disponible** (no
  gateada); `facturas`/`busqueda` sí se gatean. La búsqueda semántica DEL CHAT
  (`buscar_semantica` tool) es personal; la del buscador REST de Mis archivos sí incluye lo
  compartido accesible.
- Un **miembro sin ningún rol** no tiene capacidades → el chat le limita facturas/búsqueda
  (puede usar gestión básica de sus archivos). El admin debería darle algún rol.
- Las **facturas dentro de carpetas compartidas** se indexan (RAG) pero NO se auto-escanean a
  la analítica (no se atribuyen a un usuario).
- Archivos compartidos: **no van a la papelera** (borrado directo, afecta a todos).
- Subcarpetas compartidas: se derivan de las rutas de los archivos (no hay carpetas
  compartidas vacías persistidas).
