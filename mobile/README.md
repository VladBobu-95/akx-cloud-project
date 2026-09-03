# ATEKA Cloud — app móvil

Cliente Ionic/Angular. En esta versión solo hay login: las peticiones van al gateway (`/connected`) y, si el filtro deja pasar, a la API ATEKA.

## Arranque (navegador)

Hace falta el gateway en `http://localhost:8081` y ATEKA en `http://localhost:3000`.

```bash
cd mobile
npm install
npm start
```

Abre `http://localhost:4200` (o el puerto que indique `ng serve`). Entra con una cuenta de ATEKA (no la del panel del gateway).

## Gateway

La URL está en `src/environments/environment.ts`:

`apiUrl: 'http://localhost:8081/connected'`

En el emulador Android la app usa `http://10.0.2.2:8081/connected` (localhost del PC).

## Android (emulador)

Con ATEKA y el gateway en marcha:

```bash
npx cap sync android
npx cap open android
```

En Android Studio: Device Manager → un emulador → **Run**. No hace falta escribir Java.
