import { AppError } from "./errors";

// Tipos de archivo permitidos (mimeType real, no la extensión, que se falsifica
// trivialmente). Fuente única de verdad: lo usan el fileFilter de multer (subida
// personal y compartida) y la validación de contenido por magic bytes.
export const TIPOS_PERMITIDOS = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MENSAJE_TIPO_NO_PERMITIDO =
  "Tipo de archivo no permitido. Solo se aceptan PDF, Word (.docx), Excel (.xlsx), texto, CSV e imágenes (JPEG, PNG, WEBP).";

// El mimeType que envía el navegador/cliente al subir es solo una etiqueta y se
// puede falsificar (curl con Content-Type: application/pdf sobre un .exe). Por eso,
// igual que hacemos con el avatar (validarAvatar), comprobamos que el CONTENIDO
// real del archivo (sus "magic bytes") coincide con el tipo declarado. Sin esto,
// el fileFilter de multer se saltaría con solo mentir en la cabecera.

// Coincidencia de firma binaria por tipo. Devuelve true si el buffer empieza por
// una firma coherente con el mimeType.
const FIRMAS: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-",
  "image/png": (b) =>
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  // DOCX y XLSX son contenedores ZIP (OOXML): empiezan por "PK" seguido de una de
  // las tres variantes de cabecera ZIP (local, central vacío, spanned).
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": esZip,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": esZip,
};

function esZip(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) return false;
  const c = b[2] * 256 + b[3];
  return c === 0x0304 || c === 0x0506 || c === 0x0708;
}

// Los archivos de texto (text/plain, text/csv) no tienen firma binaria fiable. Los
// aceptamos siempre que NO parezcan binarios: un archivo de texto UTF-8 real no
// contiene bytes NUL. Con esto se rechaza subir un binario renombrado como
// .txt/.csv. Excepción: los que empiezan por un BOM UTF-16/UTF-32 (Excel exporta
// CSV así) sí contienen NUL de forma legítima → se aceptan.
function pareceTexto(b: Buffer): boolean {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    return true; // BOM UTF-16 LE/BE (o UTF-32 LE, que empieza igual)
  }
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0x00) return false;
  return true;
}

// Valida que el contenido real del buffer coincide con el mimeType permitido.
// Lanza AppError(400) si el tipo no está permitido o el contenido no cuadra.
export const validarContenidoArchivo = (buffer: Buffer, mimeType: string): void => {
  const mime = (mimeType ?? "").toLowerCase();
  if (!(TIPOS_PERMITIDOS as readonly string[]).includes(mime)) {
    throw new AppError(400, MENSAJE_TIPO_NO_PERMITIDO);
  }
  if (!buffer || buffer.length === 0) {
    throw new AppError(400, "El archivo está vacío.");
  }
  const ok =
    mime === "text/plain" || mime === "text/csv" ? pareceTexto(buffer) : FIRMAS[mime]?.(buffer);
  if (!ok) {
    throw new AppError(
      400,
      "El contenido del archivo no coincide con su tipo declarado (posible archivo manipulado).",
    );
  }
};
