> **Pasos 0–5 en curso.** App Ionic en `akx-cloud-project/mobile` (login → gateway `/connected`). Siguiente: **paso 6** Capacitor + Android Studio.
>
> Panel: http://localhost:8081/controlPanel — `admin@mid.local` / `admin12345` (local, `.env` de cloud-mid). No es el login de ATEKA.
>
> Repos: ATEKA = `Desktop\Proyectos\cloud-core\akx-cloud-project` · gateway = `Desktop\Proyectos\cloud-mid`
>
> Arrancar: compose ATEKA + `cd cloud-mid; docker compose up -d; npm run dev`
>
> Plesk (aún no): `localhost:3306`, BD `AtekaCloud`, user `ucloud`.
# Plan: app móvil + gateway (trabajo en cloud-core / Bitbucket)

## Cambio de carpeta (antes de todo)

**No seguimos en este worktree de GitHub** (`atekacloud`). El código de ATEKA que toca es:

`C:\Users\Vlad\Desktop\Proyectos\cloud-core`

- Bitbucket: `https://bitbucket.org/ateka-digital/cloud-core.git`
- El proyecto está dentro: `cloud-core\akx-cloud-project\` (backend, frontend, compose, `.env`)
- Es lo mismo que tienes aquí, pero el remoto es Bitbucket (commit `Añadir código de akx-cloud-project`)

Al implementar, **solo se edita esa ruta**. Commits y push van a Bitbucket, no a GitHub.

Hay un segundo repo vacío, pensado para el servidor Plesk:

`C:\Users\Vlad\Desktop\Proyectos\cloud-mid` → `bitbucket.org/ateka-digital/cloud-mid.git`

Ahí irá el Node del filtro + panel (`/connected` y `/controlPanel` en `https://mid-cloud.akx-server.es`). No se mezcla con ATEKA.

La app Ionic puede vivir en `cloud-core` (carpeta `mobile/`) o en un repo aparte más adelante. v1 es solo login; no hace falta decidirlo hoy.

## Paso a paso (cada paso se comprueba antes del siguiente)

Nada de montar móvil + Plesk + panel de golpe. Si un paso rompe login o Docker, se para y se arregla.

### Paso 0 — Verificar cloud-core (ahora)

1. Usar `cloud-core\akx-cloud-project` como raíz.
2. Comprobar que el stack que ya corre (db, minio, api, web) sigue respondiendo, o levantarlo desde **esta** carpeta sin crear otro Postgres.
3. Login web en http://localhost con `superadmin@ateka.com`.
4. Si el login o la API fallan, **no se empieza el gateway**.

Criterio: la web ATEKA funciona igual que ahora.

### Paso 1 — Gateway esqueleto en cloud-mid (local)

- Express en `cloud-mid`: `/connected/api/*` proxifica a `http://localhost:3000` (se quita `/connected`).
- `GET /health`.
- Probar con curl: login contra `http://localhost:8081/connected/api/auth/login` y ver el mismo token que contra `:3000`.
- La web en `:80` no se toca.

Criterio: curl al gateway = login OK; http://localhost sigue igual.

### Paso 2 — JWT en el gateway

- Si hay Bearer, `jwt.verify` con el mismo `JWT_SECRET` del `.env` de cloud-core.
- Login (sin token) se proxifica; token basura → 401 y **no** llega a la API (se mira log de `clouddrive-api`).

Criterio: perfil con token bueno OK; token inventado no aparece en logs de ATEKA.

### Paso 3 — MariaDB + IP/país + log

- Tablas en MariaDB (local primero; en Plesk `localhost:3306` después).
- Por defecto **permitir todo** (así no te cierras).
- Denegar una IP de prueba → 403 y fila en `intentos`; ATEKA no recibe la petición.

Criterio: allow all = login OK; deny tu IP de prueba = bloqueado y log.

### Paso 4 — Panel `/controlPanel`

- SPA + API propia en el mismo Node de cloud-mid.
- Login de infra (no usuarios ATEKA).
- CRUD países/IPs, tabla de intentos.

Criterio: panel usable en local; ATEKA intacta.

### Paso 5 — App Ionic (solo login)

- `apiUrl = '.../connected'` (local o Plesk).
- Token en Preferences. 401 vs 403.

Criterio: login en Ionic contra el gateway; web ATEKA sin cambios.

### Paso 6 — Capacitor + Android Studio

- `npx cap add android`, abrir `android/` en Android Studio, emulador/APK.
- Cero Java.

### Paso 7 — Subida a Plesk (cloud-mid)

- Dominio `https://mid-cloud.akx-server.es`
- `/connected` = filtro; `/controlPanel` = panel
- Env: `ATEKA_API_URL`, `JWT_SECRET` (el de cloud-core), MariaDB Plesk
- Probar con el móvil real

Criterio v1: APK → Plesk `/connected` → ATEKA; un bloqueo en el panel no llega a ATEKA.

## URLs de producción

| Quién | URL |
|---|---|
| Móvil | `https://mid-cloud.akx-server.es/connected` |
| Panel | `https://mid-cloud.akx-server.es/controlPanel` |
| ATEKA web | la de siempre (no Plesk) |

Login móvil: `POST .../connected/api/auth/login` → ATEKA `POST /api/auth/login`.

## Qué no se hace todavía

- No copiar este worktree encima de cloud-core.
- No subir Node a Plesk en el paso 0.
- No envolver el frontend actual con Capacitor.
- No duplicar usuarios ATEKA en MariaDB.
- No quitar `verificarToken` de la API.

## Credenciales

MariaDB de Plesk: **ya las tienes** (`localhost:3306`). No las pegues en el chat ni en el repo.

- Pasos 0-2: no se usan (solo ATEKA local + proxy).
- Paso 3: MariaDB local primero. Si Plesk abre 3306 en remoto, se puede usar esa; si no (lo normal), local en dev.
- Paso 7: user/password/nombre en variables de Plesk, `DB_HOST=localhost`.

JWT y URL pública de ATEKA: cuando el gateway tenga que pegar al servidor real.
## Repos

```
Desktop\Proyectos\cloud-core\akx-cloud-project   → ATEKA (Bitbucket cloud-core)
Desktop\Proyectos\cloud-mid                      → gateway + panel (Bitbucket cloud-mid)
```


