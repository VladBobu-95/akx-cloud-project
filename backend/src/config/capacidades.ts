// Vocabulario FIJO de capacidades que un rol puede otorgar. El admin nombra y
// asigna roles libremente, pero las capacidades son este set cerrado porque el
// código debe saber qué desbloquea cada una. Guardadas como text[] en
// `roles.capacidades`; añadir/partir capacidades aquí NO requiere migración.
export const CAPACIDADES = [
  "facturas", // facturas y su analítica (también lo que el chat puede consultar de ellas)
  "busqueda", // que el chat lea el CONTENIDO de los documentos (no solo nombres y carpetas)
  "gestion_archivos", // crear/copiar/mover/renombrar/eliminar + papelera
  "chat", // usar el chatbot
] as const;

export type Capacidad = (typeof CAPACIDADES)[number];

export const esCapacidadValida = (c: string): c is Capacidad =>
  (CAPACIDADES as readonly string[]).includes(c);
