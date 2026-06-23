import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
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

// 2ª pasada: OCR especialista (deepseek-ocr). La transcripción más fiel de
// texto/tablas/importes, pero lento y, ante una imagen SIN texto, alucina; por
// eso solo se usa cuando la 1ª pasada ya detectó que parece una factura.
const ocrConOllama = (buffer: Buffer): Promise<string> =>
  consultarVision(
    env.OLLAMA_OCR_MODEL,
    "Transcribe TODO el texto de esta imagen tal cual aparece (números, importes, fechas, líneas de la tabla). No añadas explicaciones.",
    buffer,
  );

// 1ª pasada: modelo de visión ligero (granite3.2-vision). Rápido, cabe entero en
// GPU y hace las dos cosas — transcribe el texto si lo hay, o describe la foto si
// no — sin entrar en el bucle degenerado de un modelo solo-OCR.
// El refuerzo de idioma va solo en la rama de descripción libre: al transcribir,
// el idioma de salida ya viene dado por el propio documento; pero generando una
// descripción desde cero, granite3.2-vision (modelo pequeño) a veces ignora "en
// español" y cae al inglés, su idioma dominante de entrenamiento para captioning.
const visionPrimeraPasada = (buffer: Buffer): Promise<string> =>
  consultarVision(
    env.OLLAMA_CAPTION_MODEL,
    "Si la imagen contiene texto (factura, recibo, documento), transcríbelo TODO tal cual aparece, con sus números e importes. Si NO contiene texto, describe brevemente lo que se ve. IMPORTANTE: la descripción debe estar SIEMPRE en español, nunca en inglés ni en otro idioma. No añadas explicaciones.",
    buffer,
  );

// Un modelo solo-OCR (deepseek-ocr) ante una foto sin texto no sabe decir "no hay
// texto" y a veces entra en un bucle degenerado repitiendo la misma etiqueta
// cientos de veces (ej. "<table:tr><td>...</table>") hasta agotar el límite de
// tokens. OJO: deepseek también emite `<table>/<td>` LEGÍTIMOS para transcribir
// las tablas de una factura real, así que NO se puede tratar esas etiquetas como
// basura por sí solas (eso descartaba transcripciones buenas). Se juzga el
// CONTENIDO tras quitar las etiquetas: si apenas queda texto real, o si lo que
// queda es muy repetitivo, es un bucle/placeholder y se descarta.
const pareceBucleDegenerado = (texto: string): boolean => {
  const sinTags = texto
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "None" (placeholder de Python/JS) como prácticamente todo el contenido.
  if (/^\W*None\W*$/i.test(sinTags)) return true;
  const palabras = sinTags.toLowerCase().split(/\s+/).filter(Boolean);
  // Tras quitar etiquetas casi no queda texto → era sopa de tags vacía.
  if (palabras.length < 3) return true;
  if (palabras.length < 30) return false;
  // Texto largo pero con muy poca variedad de palabras → repetición degenerada.
  const unicas = new Set(palabras);
  return unicas.size / palabras.length < 0.15;
};

// ¿El texto de la 1ª pasada parece una factura/recibo con importes? Es la señal
// para escalar al OCR especialista (deepseek-ocr), que no se equivoca con los
// dígitos. Una descripción de foto o un texto sin importes no lo dispara, así nos
// ahorramos la pasada lenta de deepseek en todo lo que no es factura.
const pareceFacturaConImportes = (texto: string): boolean => {
  const t = texto.toLowerCase();
  if (/[€$]|\beuros?\b|\biva\b|\bfactura\b|\bsubtotal\b|\btotal\b|\bimporte\b|\bprecio\b|\bcantidad\b|\brecibo\b/.test(t))
    return true;
  // Muchos dígitos → probable tabla/documento numérico.
  return (t.match(/\d/g) ?? []).length >= 12;
};

// Los modelos de visión de Ollama (vía llama.cpp) no decodifican WEBP de forma
// fiable: con un WEBP normal (VP8, sin animación ni alpha) la 1ª pasada devolvía
// "Failed to load image or audio file" en CPU, y llegó a tirar el proceso entero
// del runner en GPU. Reconvertir siempre a PNG antes de mandarla evita el
// problema de raíz para WEBP y de paso normaliza cualquier otro formato (JPEG
// con orientación EXIF rara, etc.) a algo que el decodificador soporta bien.
const aPng = async (buffer: Buffer): Promise<Buffer> => {
  try {
    return await sharp(buffer).png().toBuffer();
  } catch (err) {
    console.error("[extraccion] no se pudo normalizar la imagen a PNG, se manda tal cual:", err);
    return buffer;
  }
};

// OCR/descripción de una imagen, cascada "ligero primero":
//   1. granite (rápido) transcribe el texto o describe la foto.
//   2. Si lo que sacó parece una factura con importes Y hay un modelo de OCR
//      distinto configurado, se RE-LEE con deepseek-ocr para máxima fidelidad de
//      los dígitos; si deepseek falla o alucina, nos quedamos con lo de granite.
//   3. Si no parece factura (foto, o texto sin importes), se usa lo de granite —
//      sin pagar la pasada lenta de deepseek.
// Si OLLAMA_OCR_MODEL == OLLAMA_CAPTION_MODEL (máquinas con un solo VLM), la 2ª
// pasada se desactiva sola.
const ocrImagen = async (bufferOriginal: Buffer): Promise<string> => {
  const buffer = await aPng(bufferOriginal);

  let primera = "";
  try {
    primera = await visionPrimeraPasada(buffer);
  } catch (err) {
    console.error("[extraccion] visión (1ª pasada) falló:", err);
  }
  primera = pareceBucleDegenerado(primera) ? "" : primera.trim();

  if (env.OLLAMA_OCR_MODEL !== env.OLLAMA_CAPTION_MODEL && pareceFacturaConImportes(primera)) {
    try {
      const ocr = await ocrConOllama(buffer);
      if (ocr.trim() && !pareceBucleDegenerado(ocr)) return ocr.trim();
    } catch (err) {
      console.error("[extraccion] OCR especialista (2ª pasada) falló:", err);
    }
  }
  return primera;
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
