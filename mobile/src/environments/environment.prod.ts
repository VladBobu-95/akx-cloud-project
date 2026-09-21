// Direcciones del backend. TODAS las URLs de la app salen de aquí (vía
// core/urls.ts): no escribas direcciones en los servicios.
//  - web:     navegador (npm start / ng serve)
//  - android: app nativa
// PRODUCCIÓN: todo entra por el gateway de Plesk. /gate y /salida los atiende
// el propio gateway y /connected/api/... lo reenvía a la API de ATEKA del
// servidor (ATEKA_API_URL en cloud-mid). Requiere el mismo JWT_SECRET en ambos.
// A futuro, cuando ATEKA tenga su propia URL pública (en vez del túnel SSH),
// basta con poner esa URL en `atekaUrl` y dejar el gateway solo para el filtro
// (`/gate` y `/salida`). Nada más cambia: los servicios leen estos valores.
const GATEWAY = 'https://mid-cloud.akx-server.es/connected';

export const environment = {
  production: true,
  // Gateway cloud-mid: /gate (filtro IP/país) y /salida (presencia).
  gatewayUrl: { web: GATEWAY, android: GATEWAY },
  // API de ATEKA (/api/...), a través del proxy del gateway.
  atekaUrl: { web: GATEWAY, android: GATEWAY },
};
