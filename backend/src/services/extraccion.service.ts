import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { createWorker, Worker } from "tesseract.js";
import { env } from "../config/env";

// MIME de un .docx (Word moderno).
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// --- OCR de imágenes: deepseek-ocr (Ollama) primero, Tesseract.js de fallback ---
// Worker de Tesseract perezoso: inicializarlo es caro, se crea una vez y se reutiliza.
let workerPromise: Promise<Worker> | null = null;
const getWorker = (): Promise<Worker> => {
  if (!workerPromise) workerPromise = createWorker("spa");
  return workerPromise;
};

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
      options: { temperature: 0 },
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

// Descarga un modelo de la VRAM de Ollama ya mismo (keep_alive: 0), sin esperar
// a que expire su keep_alive normal. Se usa antes de pasar de deepseek-ocr a
// llava: en GPUs con poca VRAM no caben los dos modelos cargados a la vez, y
// bajar OLLAMA_MAX_LOADED_MODELS afectaría a otros proyectos que comparten el
// mismo Ollama. Mejor esfuerzo: si falla, simplemente no se libera a tiempo.
const descargarModelo = async (modelo: string): Promise<void> => {
  try {
    await fetch(`${env.OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelo, keep_alive: 0 }),
    });
  } catch {
    // No crítico: si Ollama no responde a esto, el siguiente intento (llava)
    // simplemente seguirá fallando si no cabe en VRAM, igual que antes.
  }
};

// deepseek-ocr es solo-OCR: ante una foto sin texto no sabe describirla, solo
// transcribir (o alucinar). llava sí sabe describir fotos normales.
const describirConOllama = (buffer: Buffer): Promise<string> =>
  consultarVision(
    env.OLLAMA_CAPTION_MODEL,
    "Describe brevemente en español (1-2 frases) qué se ve en esta imagen, para poder encontrarla luego buscándola por su contenido. No inventes detalles que no se vean realmente.",
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

// OCR de una imagen, en cascada:
// 1. deepseek-ocr: mucho mejor leyendo tablas/importes de un documento real.
// 2. Si no hay texto real (alucina/bucle degenerado), llava describe la foto
//    en vez de transcribirla — para fotos normales (objetos, personas...).
// 3. Si Ollama no responde a ninguno de los dos, Tesseract.js de último recurso.
const ocrImagen = async (buffer: Buffer): Promise<string> => {
  // El modelo de chat puede estar cargado (p. ej. si esta llamada viene de
  // "escanea factura X" en el chat, donde el modelo de chat decidió la tool
  // call justo antes). En GPUs con poca VRAM, chat + deepseek-ocr tampoco
  // caben juntos — se libera el de chat antes de cargar el de OCR.
  await descargarModelo(env.OLLAMA_MODEL);
  try {
    const texto = await ocrConOllama(buffer);
    if (!pareceBucleDegenerado(texto)) return texto;
    console.error("[extraccion] OCR Ollama devolvió un bucle degenerado, probando a describir con llava");
  } catch (err) {
    console.error("[extraccion] OCR Ollama falló, probando a describir con llava:", err);
  }
  await descargarModelo(env.OLLAMA_OCR_MODEL);
  try {
    return await describirConOllama(buffer);
  } catch (err) {
    console.error("[extraccion] Descripción Ollama falló, usando Tesseract:", err);
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    return pareceBucleDegenerado(data.text ?? "") ? "" : (data.text ?? "");
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

    // Imagen: OCR (deepseek-ocr vía Ollama, con fallback a Tesseract.js).
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
