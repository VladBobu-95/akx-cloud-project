// Vocabulario FIJO de capacidades que un rol puede otorgar. El admin nombra y
// asigna roles libremente, pero las capacidades son este set cerrado porque el
// código debe saber qué desbloquea cada una (RBAC del chat en Fase 3 vía un mapa
// tool→capacidad). Guardadas como text[] en `roles.capacidades`; añadir/partir
// capacidades aquí NO requiere migración.
export const CAPACIDADES = [
  "facturas", // escanear/listar facturas + analítica (ventas_top, totales, clientes_top, obtener_factura)
  "busqueda", // búsqueda semántica (RAG) y leer contenido de archivos
  "gestion_archivos", // crear/copiar/mover/renombrar/eliminar + papelera
  "chat", // usar el chatbot
] as const;

export type Capacidad = (typeof CAPACIDADES)[number];

export const esCapacidadValida = (c: string): c is Capacidad =>
  (CAPACIDADES as readonly string[]).includes(c);
