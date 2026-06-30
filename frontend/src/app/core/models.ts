export interface Usuario {
  id: string;
  email: string;
  nombre?: string;
  avatar?: string | null;
  rol: 'superadmin' | 'admin' | 'miembro';
  empresaId?: string | null;
  creadoEn?: string;
}

// Empresa (tenant). La gestiona el superadmin desde el panel de plataforma.
export interface Empresa {
  id: string;
  nombre: string;
  estado: 'activa' | 'suspendida';
  creadoEn?: string;
  usuariosCount?: number;
}

// Rol funcional configurable por el admin (contabilidad, mantenimiento...).
export interface Rol {
  id: string;
  nombre: string;
  capacidades: string[];
  empresaId?: string;
  creadoEn?: string;
}

// Carpeta compartida. En la vista de admin incluye los roles con acceso; en la
// lista de accesibles del miembro llega solo {id, nombre}.
export interface CarpetaCompartida {
  id: string;
  nombre: string;
  empresaId?: string;
  roles?: { id: string; nombre: string }[];
  creadoEn?: string;
}

// Miembro del equipo (usuario de la empresa) tal como lo devuelve /api/equipo.
export interface Miembro {
  id: string;
  email: string;
  nombre?: string;
  rol: 'admin' | 'miembro';
  roles: { id: string; nombre: string; capacidades: string[] }[];
  creadoEn?: string;
}

export interface Archivo {
  id: string;
  nombre: string;
  carpeta: string;
  mimeType: string;
  tamanoBytes: string;
  claveMinio?: string;
  hashSha256?: string | null;
  textoExtraido?: string | null;
  eliminadoEn?: string | null;
  subidoEn: string;
  estadoEscaneo?: 'pendiente' | 'escaneando' | 'escaneada' | 'no_factura' | 'error' | null;
  // Estado del indexado RAG (extracción de texto + embeddings), independiente
  // del escaneo de factura. Lo gestiona la cola durable del backend.
  estadoIndexado?: 'pendiente' | 'indexando' | 'indexado' | 'error' | null;
  indexadoEn?: string | null;
  // Transitorio (solo en la respuesta de subir): true si el contenido ya existía
  // y se reutilizó en vez de volver a subirse/procesarse (dedup por hash).
  duplicado?: boolean;
}

export interface AuthResponse {
  usuario: Usuario;
  token: string;
}

export interface ListaArchivos {
  archivos: Archivo[];
  total: number;
  paginas: number;
  pagina: number;
}

// Resultado de la búsqueda semántica (RAG): archivo + fragmento que coincide.
export interface ResultadoBusqueda {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string;
  score: number;
}
