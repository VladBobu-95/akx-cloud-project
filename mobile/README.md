# ATEKA Cloud — app móvil

Cliente **Ionic/Angular + Capacitor (Android)** de ATEKA Cloud.

Las cuentas son las de ATEKA (las de la web / el servidor GPU), **no** las del panel del gateway (`cloud-mid`).

Este `README.md` vive dentro de `akx-cloud-project/mobile/`. Si ves varias copias en el disco, son el **mismo archivo en distintos clones** (worktree de Grok, `cloud-core` de Android Studio, carpeta GPU). No hay tres documentos distintos.

Android Studio abre: `Desktop\Proyectos\cloud-core\akx-cloud-project`.

## Qué hay ahora

Tras el login, barra inferior (Perfil **no** es pestaña: se abre con el avatar de la cabecera):

| Tab | Pantalla |
|---|---|
| Chat | Asistente (`POST /api/chat`) |
| Archivos | Explorador personal / compartido (subir, carpetas, búsqueda, visor) |
| Facturas | Venta / compra / sin clasificar. Buscar, **Filtrar** (fecha, emisor, cliente, total; agrupa por emisor/cliente), editor. Reclasificar en ⋮ |
| Papelera | Soft-delete, restaurar, borrar definitivo |

**Perfil** (avatar): foto, modo oscuro, nombre, contraseña (superadmin), CIF de empresa (admin), salir.

Cabeceras: icono a la izquierda, título, ⋮ si hay más acciones, chip de avatar a la derecha.

## Cómo habla con los servidores

Hay **dos** destinos. El filtro no es ATEKA, y ATEKA no es el panel.

```
App  →  Plesk /connected/gate     ¿esta IP/país puede pasar?
     →  Plesk /connected/salida   al cerrar sesión (quita el dispositivo del panel)
     →  ATEKA /api/...            login, chat, archivos, facturas  (túnel SSH al GPU)
```

### Android (emulador)

1. Filtro IP/país → Plesk `https://mid-cloud.akx-server.es/connected/gate`
2. Si el cuerpo es `{ok:true}`, login y el resto → ATEKA en el servidor GPU, vía túnel SSH (`atekaUrl`, puerto **3001**)

El emulador **no** usa el Node local de cloud-mid (`:8081`). Usa Plesk para el filtro.

En Android el túnel `-L` solo escucha en `127.0.0.1` del PC. Capacitor usa `127.0.0.1` + `adb reverse` (no `10.0.2.2` para ATEKA). Ver `src/app/core/api.ts`.

### Túnel SSH al servidor GPU

El `:3000` del GPU no sale a internet. En el PC, **otra** terminal, y no la cierres:

```bash
ssh -p 322 -L 3001:127.0.0.1:3000 USUARIO@IP
```

El `3001` evita chocar con un ATEKA local en el `3000`. Comprobar: `curl http://localhost:3001/health`.

Tras abrir el túnel:

```bash
"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" reverse tcp:3001 tcp:3001
```

(`npm run android:live` ya lo hace). Login: el **email completo** (con `@`), el mismo que en la web del servidor.

Cuentas: las del **servidor**, no las de Docker local. Para volver al PC: `atekaUrl: 'http://localhost:3000'` en `src/environments/environment.ts`.

Cada AVD guarda un `device_id` (UUID) en Preferences. Las pestañas hacen ping a `/gate` cada **5 s** con `X-Device-Id`. Al cerrar sesión: `GET /connected/salida` con el mismo id. Otro emulador no se toca.

### Navegador (`npm start`)

- Filtro: `http://localhost:8081/connected` (`environment.apiUrl`)
- ATEKA: `http://localhost:3001` (`environment.atekaUrl`, túnel)

Hace falta el túnel abierto y, para el filtro en el navegador, cloud-mid en `:8081`.

## Arranque (navegador)

```bash
cd mobile
npm install
npm start
```

Abre `http://localhost:4200`. Tras el login entra al chat.

## Android (emulador)

Siempre desde `mobile/`.

### Build empaquetado (el flujo normal)

Tras cambiar HTML/TS/SCSS:

```bash
cd mobile
npx ng build --configuration=development
npx cap sync android
```

En Android Studio: Device Manager → emulador → **Run**. No hace falta escribir Java.

- Varios emuladores: **Run → Run on Multiple Devices…**. Un AVD nuevo no trae la app: hay que hacer Run en ese dispositivo.
- El Pixel 10 (imagen 16 KB) a veces arranca sin DNS/Internet y el login falla. WiFi off/on en el emulador, o Device Manager → **Cold Boot Now**.
- Android Studio **Sync / Build** no recompila Angular. Sin `ng build` + `cap sync`, el APK sigue con el `www/` viejo.

### Live reload (opcional)

Dos terminales, **siempre desde `mobile/`**:

```bash
# 1) servidor web (déjalo abierto)
npm start
```

```bash
# 2) lanza el emulador apuntando a ese servidor
npm run android:live
```

Un cambio en `.html` / `.ts` / `.scss` se recarga solo. No hace falta `ng build` ni `cap sync` en cada cambio.

Si no cuadra:

- `cap run -l` **no arranca** `ng serve`; hay que tenerlo ya en marcha.
- Sin `--port 4200` Capacitor usa el **3000** (la API, no Angular). El script `android:live` ya pone host `10.0.2.2` y puerto `4200` para el live reload (el live reload es Angular; ATEKA va por el túnel).
- `ng serve` escucha `0.0.0.0` y admite el host `10.0.2.2` (si no, Vite bloquea al emulador).
- `android:live` usa el JDK embebido de Android Studio (`JAVA_HOME`). En esta máquina el JBR bueno está en `Android Studio1\jbr` (el de `Android Studio\jbr` está incompleto). Si Gradle se queja, abre una **terminal nueva**.
- Si Windows pregunta por el firewall al arrancar `npm start`, permite redes privadas.
- Ctrl+C en `android:live` quita el `server.url` temporal. Apagar `npm start` **no** rompe un APK empaquetado (el que salió de `cap sync`).

## Chat y facturas

Misma API que la web. Chat: `POST /api/chat` con el JWT. En Android va al túnel (`127.0.0.1:3001`). El historial se guarda en el teléfono y se borra al cerrar sesión.

Ollama (modelos, OCR, embeddings) corre **en el GPU**, no en el teléfono. Si el chat o el escaneo fallan, es la API/Ollama del servidor, no Plesk.

El explorador y las facturas van en sus pestañas; desde el chat aún no se abre el archivo en el visor nativo.

## Panel del gateway

`https://mid-cloud.akx-server.es/controlPanel` — reglas de IP/país, intentos, dispositivos activos y perfil del admin del panel. Login: el de **cloud-mid**, no el de ATEKA.

Dos emuladores a la vez = dos filas. Logout en uno quita solo esa fila.
