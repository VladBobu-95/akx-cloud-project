// Direcciones del backend. TODAS las URLs de la app salen de aquí (vía
// core/urls.ts): no escribas direcciones en los servicios.
//  - web:     navegador (npm start / ng serve)
//  - android: app nativa (en el emulador, 10.0.2.2 es el PC anfitrión)
export const environment = {
  production: false,
  // Gateway cloud-mid: /gate (filtro IP/país) y /salida (presencia).
  gatewayUrl: {
    web: 'https://mid-cloud.akx-server.es/connected',
    android: 'https://mid-cloud.akx-server.es/connected',
  },
  // API de ATEKA (/api/...).
  atekaUrl: {
    web: 'http://localhost:3001',
    android: 'http://10.0.2.2:3001',
  },
};
