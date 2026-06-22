import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { env } from "../config/env";

// MIME de un .docx (Word moderno).
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Tope de tokens generados por el OCR de visión. Sin esto, una foto sin texto
// real puede entrar en un bucle degenerado (ver pareceBucleDegenerado) y gastar
// el máximo del modelo (~115s observados) antes de cortar. Una factura real,
// con sus líneas y totales, no necesita ni de lejos 800 tokens para
// transcribirse entera, así que el límite no afecta al caso bueno.
const MAX_TOKENS_OCR = 800;

const consultarVision = async (modelo: string, prompt: string, buffer: Buffer): Promise<string> => {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelo,
      messages: [
        {
          role: "user",
          content: prompt,
          images: [buffer.toString("base64")],
        },
      ],
      stream: false,
      options: { temperature: 0, num_predict: MAX_TOKENS_OCR },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string }; error?: string };
  if (!res.ok || data.error || !data.message?.content) {
    throw new Error(`Modelo de visión (${modelo}) falló: ${data.error ?? res.status}`);
  }
  return data.message.content;
};

const ocrConOllama = (buffer: Buffer): Promise<string> =>
  consultarVision(
    env.OLLAMA_OCR_MODEL,
    "Transcribe TODO el texto de esta imagen tal cual aparece (números, importes, fechas, líneas de la tabla). No añadas explicaciones.",
    buffer,
  );

// deepseek-ocr es un modelo SOLO de OCR: ante una foto sin texto (un objeto, una
// persona...) no sabe decir "no hay texto" y en vez de eso a veces entra en un
// bucle degenerado repitiendo la misma etiqueta cientos de veces (ej. "<table:tr>
// <td>...</table>") hasta agotar el límite de tokens. Se detecta por la baja
// variedad de palabras (una transcripción real, aunque sea corta, no repite
// siempre los mismos tokens) y se descarta en vez de guardar la basura.
const pareceBucleDegenerado = (texto: string): boolean => {
  // Señal corta pero inequívoca: "None" (placeholder de Python/JS) o etiquetas
  // <table>/<td> sueltas no son nunca texto real de un documento.
  if (/\bNone\b/.test(texto) || /<table[ :>]|<td[ >]/i.test(texto)) return true;
  const palabras = texto.toLowerCase().split(/\s+/).filter(Boolean);
  if (palabras.length < 30) return false;
  const unicas = new Set(palabras);
  return unicas.size / palabras.length < 0.15;
};

// OCR de una imagen: solo deepseek-ocr. Si no encuentra texto real (alucina/
// bucle degenerado) o Ollama no responde, no hay fallback automático (antes
// llava describía la foto y, si Ollama tampoco respondía, Tesseract.js hacía
// un OCR de peor calidad) — el explorador obliga al usuario a describir a mano
// toda imagen que suba (ver modal "¿Qué es esta imagen?"), así que ese texto
// vacío se rellena siempre con la descripción manual, sin depender de más IA.
const ocrImagen = async (buffer: Buffer): Promise<string> => {
  try {
    const texto = await ocrConOllama(buffer);
    return pareceBucleDegenerado(texto) ? "" : texto;
  } catch (err) {
    console.error("[extraccion] OCR Ollama falló:", err);
    return "";
  }
};

// Carácter NUL: hay que quitarlo del texto extraído porque Postgres no admite
//  en columnas de texto. Se construye así para no meter el byte en el código.
const NUL = String.fromCharCode(0);

// Extrae el texto de un archivo a partir de su buffer (lo que da Multer en la
// subida). Devuelve el texto plano o null si el formato no es indexable
// (imágenes, binarios...). Nunca lanza: si algo falla, devuelve null y loguea.
export const extraerTexto = async (
  buffer: Buffer,
  mimeType: string,
  nombre: string,
): Promise<string | null> => {
  const mt = (mimeType ?? "").toLowerCase();
  const nom = (nombre ?? "").toLowerCase();

  try {
    if (mt === "application/pdf" || nom.endsWith(".pdf")) {
      const parser = new PDFParse({ data: buffer });
      const res = await parser.getText();
      await parser.destroy();
      return limpiar(res.text);
    }

    if (mt === DOCX_MIME || nom.endsWith(".docx")) {
      const res = await mammoth.extractRawText({ buffer });
      return limpiar(res.value);
    }

    // Texto plano: text/*, json, csv, markdown, xml, o por extensión conocida.
    if (
      /^text\//.test(mt) ||
      /application\/(json|xml|csv|markdown)/.test(mt) ||
      /\.(txt|md|csv|json|log|xml|html?)$/.test(nom)
    ) {
      return limpiar(buffer.toString("utf8"));
    }

    // Imagen: OCR con deepseek-ocr vía Ollama (sin fallback automático).
    if (/^image\//.test(mt)) {
      return limpiar(await ocrImagen(buffer));
    }

    return null; // formato no soportado (binarios, etc.)
  } catch (err) {
    console.error(`Error extrayendo texto de "${nombre}":`, err);
    return null;
  }
};

// Normaliza: quita el carácter NUL, recorta y descarta si queda vacío.
const limpiar = (texto: string): string | null => {
  const limpio = (texto ?? "").split(NUL).join("").trim();
  return limpio.length > 0 ? limpio : null;
};
