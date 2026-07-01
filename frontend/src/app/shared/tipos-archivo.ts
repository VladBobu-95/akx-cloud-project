// Tipos de archivo aceptados por la subida (debe coincidir con TIPOS_PERMITIDOS
// del backend, backend/src/utils/tiposArchivo.ts). El backend es el que manda
// (valida además el contenido real por magic bytes); esto es solo la primera
// criba en cliente para no molestar al usuario con una subida que va a fallar.

// Extensiones permitidas (en minúscula, con punto). Se valida por extensión
// porque `File.type` (mimeType) llega vacío en algunos navegadores/SO.
export const EXTENSIONES_PERMITIDAS = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.txt',
  '.csv',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
];

// Valor para el atributo `accept` del <input type="file"> (filtra el diálogo del SO).
export const ACCEPT_ARCHIVOS = EXTENSIONES_PERMITIDAS.join(',');

// true si el archivo tiene una extensión permitida.
export function esTipoPermitido(file: File): boolean {
  const nombre = file.name.toLowerCase();
  const punto = nombre.lastIndexOf('.');
  if (punto < 0) return false;
  return EXTENSIONES_PERMITIDAS.includes(nombre.slice(punto));
}

export const MENSAJE_TIPO_NO_PERMITIDO =
  'Formato no permitido. Solo se aceptan PDF, Word (.docx), Excel (.xlsx), texto, CSV e imágenes (JPG, PNG, WEBP).';

// Tamaño máximo por archivo (debe coincidir con el límite de multer en el backend).
export const MAX_ARCHIVO_BYTES = 50 * 1024 * 1024;
export const MENSAJE_ARCHIVO_GRANDE = 'El archivo es demasiado grande (máximo 50 MB).';
