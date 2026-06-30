export interface Usuario {
  id: string;
  email: string;
  nombre?: string;
  avatar?: string | null;
  rol: string;
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
