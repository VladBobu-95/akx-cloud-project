# ATEKA Cloud — app móvil

Cliente **Ionic/Angular + Capacitor (Android)** de ATEKA Cloud.

Las cuentas son las de ATEKA (`superadmin@ateka.com` en local), no las del panel del gateway (`cloud-mid`).

## Qué hay ahora

Tras el login, barra inferior:

| Tab | Pantalla |
|---|---|
| Chat | Asistente (`POST /api/chat`) |
| Archivos | Explorador personal / compartido (subir, carpetas, búsqueda, visor) |
| Facturas | Listado venta/compra/sin clasificar, reclasificar, editor |
| Papelera | Soft-delete, restaurar, borrar definitivo |
| Perfil | Avatar, nombre, contraseña, tema claro/oscuro, CIF de empresa (admin), salir |

Cabeceras: icono a la izquierda (`folder-outline` / `receipt-outline` / `trash-outline`), título, chip de avatar a la derecha (abre Perfil).

## Cómo habla con los servidores

### Android (emulador)

Login **híbrido**:

1. Filtro IP/país → Plesk `https://mid-cloud.akx-server.es/connected/gate`
2. Si el cuerpo es `{ok:true}`, login y el resto de la API → ATEKA en el PC (`http://10.0.2.2:3000`)

El emulador **no** usa el Node local de cloud-mid (`:8081`). Usa Plesk.

Cada AVD guarda un `device_id` (UUID) en Preferences. Las pestañas hacen ping a `/gate` cada **5 s** con cabecera `X-Device-Id`. Al cerrar sesión: `GET /connected/salida?device=…` (también `X-Device-Id`) para quitar **ese** dispositivo del panel. El otro emulador no se toca: cada uno tiene su id.

### Navegador (`npm start`)

- Filtro: `http://localhost:8081/connected` (`src/environments/environment.ts`)
- ATEKA: `http://localhost:3000`

Hace falta ATEKA en `:3000` y, para el filtro en el navegador, cloud-mid en `:8081`.

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
- Sin `--port 4200` Capacitor usa el **3000** (la API, no Angular). El script `android:live` ya pone host `10.0.2.2` y puerto `4200`.
- `ng serve` escucha `0.0.0.0` y admite el host `10.0.2.2` (si no, Vite bloquea al emulador).
- `android:live` usa el JDK embebido de Android Studio (`JAVA_HOME`). En esta máquina el JBR bueno está en `Android Studio1\jbr` (el de `Android Studio\jbr` está incompleto). Si Gradle se queja, abre una **terminal nueva**.
- Si Windows pregunta por el firewall al arrancar `npm start`, permite redes privadas.
- Ctrl+C en `android:live` quita el `server.url` temporal. Apagar `npm start` **no** rompe un APK empaquetado (el que salió de `cap sync`).

## Chat

Misma API que la web: `POST /api/chat` con el JWT. En Android va a `10.0.2.2:3000`. Hace falta Ollama en el PC. El historial se guarda en el teléfono y se borra al cerrar sesión.

El explorador y las facturas van en sus pestañas; desde el chat aún no se abre el archivo en el visor nativo.

## Panel del gateway

`https://mid-cloud.akx-server.es/controlPanel` — reglas de IP/país, intentos y **dispositivos activos** (vistos en los últimos 5 minutos). Login del panel: el de cloud-mid, no el de ATEKA.

Dos emuladores a la vez = dos filas. Logout en uno quita solo esa fila.
