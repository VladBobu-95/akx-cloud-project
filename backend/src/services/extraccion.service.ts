import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { env } from "../config/env";
import { campoThink, KEEP_ALIVE, ollamaHeaders } from "../config/ollama";

// MIME de un .docx (Word moderno).
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Tope de tokens generados por el OCR de visión. Sin esto, una foto sin texto
// real puede entrar en un bucle degenerado (ver pareceBucleDegenerado) y gastar
// el máximo del modelo antes de cortar. Da de sobra para transcribir una factura
// entera con sus líneas y totales.
const MAX_TOKENS_OCR = 1500;

// OCR / descripción de una imagen con el modelo de la app (OLLAMA_MODEL, el mismo
// del chat y las facturas). Hace las dos cosas en una llamada: transcribe el texto
// si lo hay, o describe la foto si no. Mismo num_ctx y keep_alive que el resto de
// llamadas (si difieren, Ollama recarga el modelo) y sin modo pensamiento, que en
// OCR no aporta y lo haría lento.
const PROMPT_VISION =
  "Si la imagen contiene texto (factura, recibo, documento), transcríbelo TODO tal cual aparece, con sus números, importes, fechas y las líneas de las tablas. Si NO contiene texto, describe brevemente lo que se ve, en español. No añadas explicaciones.";

const consultarVision = async (buffer: Buffer): Promise<string> => {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      messages: [
        {
          role: "user",
          content: PROMPT_VISION,
          images: [buffer.toString("base64")],
        },
      ],
      stream: false,
      ...(await campoThink(env.OLLAMA_MODEL, false)),
      options: { temperature: 0, num_predict: MAX_TOKENS_OCR, num_ctx: env.OLLAMA_NUM_CTX },
      keep_alive: KEEP_ALIVE,
    }),
    // Timeout para no colgarse si Ollama no puede cargar el modelo (ver
    // OLLAMA_TIMEOUT_MS). Si salta, leerImagen lo captura y la imagen queda sin texto.
    signal: AbortSignal.timeout(env.OLLAMA_TIMEOUT_MS),
  });
  const data = (await res.json()) as {
    message?: { content?: string };
    error?: string;
    done?: boolean;
    done_reason?: string;
  };
  if (!res.ok || data.error || !data.message?.content) {
    // res.status solo no basta para diagnosticar: Ollama puede responder 200 con
    // el contenido vacío (ej. el modelo no llegó a generar nada por falta de
    // VRAM). done_reason ayuda a distinguir ese caso de un error real de la API.
    throw new Error(
      `Visión (${env.OLLAMA_MODEL}) falló: status=${res.status} error=${data.error ?? "-"} done=${data.done ?? "-"} done_reason=${data.done_reason ?? "-"}`,
    );
  }
  return data.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
};

// Ante una foto sin texto, un modelo de visión puede entrar en un bucle
// degenerado repitiendo la misma etiqueta cientos de veces (ej.
// "<table:tr><td>...</table>") hasta agotar el límite de tokens. OJO: también
// emite `<table>/<td>` LEGÍTIMOS para transcribir las tablas de una factura real,
// así que NO se puede tratar esas etiquetas como basura por sí solas (eso
// descartaba transcripciones buenas). Se juzga el CONTENIDO tras quitar las
// etiquetas: si apenas queda texto real, o si lo que queda es muy repetitivo, es
// un bucle/placeholder y se descarta.
const pareceBucleDegenerado = (texto: string): boolean => {
  const teniaTags = /<[^>]*>/.test(texto);
  const sinTags = texto
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "None" (placeholder de Python/JS) como prácticamente todo el contenido.
  if (/^\W*None\W*$/i.test(sinTags)) return true;
  const palabras = sinTags.toLowerCase().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return true; // no quedó nada
  // Tras quitar etiquetas casi no queda texto → era sopa de tags vacía. OJO: esto
  // solo tiene sentido si el texto original tenía etiquetas — una respuesta corta
  // SIN etiquetas (ej. "Gato" como descripción de una foto) es válida.
  if (teniaTags && palabras.length < 3) return true;
  // Ristra de números sueltos ("1 2 3 ... 64"): un modelo de OCR que se cuelga
  // contando (visto al echar el prompt + contar). Todos los enteros son distintos,
  // así que el chequeo de repetición de abajo NO lo caza por variedad; pero no es
  // texto real — una factura trae importes con decimales y palabras, no enteros
  // consecutivos sueltos.
  const enteros = palabras.filter((p) => /^\d+$/.test(p));
  if (enteros.length >= 15 && enteros.length / palabras.length > 0.5) return true;
  if (palabras.length < 30) return false;
  // Texto largo pero con muy poca variedad de palabras → repetición degenerada.
  const unicas = new Set(palabras);
  return unicas.size / palabras.length < 0.15;
};

// Los modelos de visión a veces transcriben las tablas de una factura como HTML
// (<table><td>...), pero pdf-parse (el otro origen posible de este mismo texto) nunca devuelve
// HTML, solo texto plano. Sin esto, el contenido guardado (lo que se ve al
// leer el archivo en el chat y lo que se
// le pasa a la extracción de datos de la factura) sale con pinta distinta según
// si vino de OCR o de un PDF. Se aplica DESPUÉS de pareceBucleDegenerado (que sí
// necesita ver las etiquetas originales para distinguir tabla legítima de sopa
// de tags vacía) y solo sobre el texto que ya se decidió conservar.
const limpiarTablasHtml = (texto: string): string =>
  texto
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/td\s*>/gi, " | ")
    .replace(/<[^>]*>/g, "")
    .replace(/ \|\s*\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ¿El texto parece una factura/recibo con importes? En un PDF con capa de texto
// es la señal para OCR-ear el membrete (ver extraerTexto). Una descripción de
// foto o un texto sin importes no lo dispara.
export const pareceFacturaConImportes = (texto: string): boolean => {
  const t = texto.toLowerCase();
  // Señal FIABLE de factura/recibo: un importe monetario de verdad — símbolo de
  // moneda pegado a dígitos (€ 120 / 120€) o un número con decimales de céntimos
  // (120,00 / 1.234,56 / 50.00). El umbral antiguo ("una palabra suelta como
  // 'total'/'importe', o ≥12 dígitos cualesquiera") colaba con basura: el eco del
  // prompt del OCR ("...número, importe, fecha... 1 2 3 ... 64") contiene
  // "importe" y 60+ dígitos, y una descripción normal de foto dice "total"/
  // "cantidad" sin ser una factura. Pedir un importe con formato monetario evita
  // ambos falsos positivos.
  if (/[€$]\s*\d|\d\s*[€$]|\b\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/.test(t)) return true;
  // Sin importe explícito, solo cuentan términos INEQUÍVOCOS de factura (no
  // "total"/"precio"/"cantidad", que salen en descripciones de fotos cualesquiera).
  // Se incluyen las variantes en catalán ("base imposable", "rebut") e inglés
  // ("invoice", "vat"), para no dejar fuera una factura en esas lenguas que no
  // traiga un importe con formato monetario claro.
  return /\bfactura\b|\binvoice\b|\biva\b|\bvat\b|\bsubtotal\b|\bbase imponible\b|\bbase imposable\b|\brecibo\b|\brebut\b/.test(t);
};

// ¿El texto trae la línea legal del emisor ("… inscrita en el Registro Mercantil …",
// también catalán "Registre" / gallego "Rexistro")? Si está, el emisor ya vive en
// la capa de texto y NO hace falta OCR-ear el membrete (que solo añadiría ruido).
// Misma expresión que en facturas.service.ts (reconciliarPartes); se duplica aquí
// porque facturas importa de extraccion, no al revés (evita un ciclo).
const RE_REGISTRO_MERCANTIL_TXT = /(?:inscrit[ao]\b[^\n]{0,40}?)?re[gx]istr[eo]\s+mercantil/i;
export const tieneRegistroMercantil = (texto: string): boolean =>
  RE_REGISTRO_MERCANTIL_TXT.test(texto ?? "");

// Corta una promesa que se cuelgue (p. ej. el rasterizado del PDF).
const conTimeout = <T>(p: Promise<T>, ms: number, etiqueta: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${etiqueta} timeout`)), ms)),
  ]);

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

// Texto de una imagen (foto o página de PDF) con el modelo de visión. Nunca
// lanza: si Ollama falla o el modelo entra en bucle, devuelve "".
const leerImagen = async (png: Buffer): Promise<string> => {
  let texto = "";
  try {
    texto = await consultarVision(png);
  } catch (err) {
    console.error("[extraccion] visión falló:", err);
  }
  return pareceBucleDegenerado(texto) ? "" : limpiarTablasHtml(texto.trim());
};

// OCR/descripción de una imagen subida: el modelo de visión transcribe el texto o
// describe la foto.
const ocrImagen = async (buffer: Buffer): Promise<string> => leerImagen(await aPng(buffer));

// Escala de rasterizado del PDF antes del OCR: a escala 1 la página A4 sale a
// ~595px de ancho y el texto pequeño/denso se pierde; x2 (~1190px) basta para
// leerlo. Tope de páginas para un PDF escaneado sin capa de texto: cada página es
// una llamada al modelo (varios segundos), y la tarea entera tiene un tope de
// WORKER_TAREA_TIMEOUT_MS — el membrete/emisor y casi todas las facturas caben en
// muchas menos.
const ESCALA_OCR_PDF = 2;
const MAX_PAGINAS_OCR_PDF = 5;
// Timeout DURO del rasterizado: si getScreenshot se colgara (visto: el archivo se
// quedaba "procesando" para siempre — puede pasar en el contenedor por las libs
// nativas de canvas/pdfjs), se aborta y la extracción sigue solo con la capa de
// texto de pdf-parse.
const TIMEOUT_RASTER_MS = 30_000;

// Rasteriza las primeras `maxPaginas` de un PDF (con la MISMA instancia de
// PDFParse ya abierta) y devuelve el texto que el modelo de visión saca de esas
// imágenes. Sirve para leer lo que pdf-parse NO ve: texto que en el PDF va como
// IMAGEN —logos/membretes con el nombre y NIF del emisor, o una factura entera
// escaneada—.
// Nunca lanza: si el rasterizado falla (p. ej. faltan libs nativas de canvas en
// el contenedor), devuelve "" y la extracción continúa solo con la capa de texto.
const ocrPaginasPdf = async (parser: PDFParse, maxPaginas: number): Promise<string> => {
  let paginas: { data: Uint8Array }[];
  try {
    const shot = await conTimeout(
      parser.getScreenshot({ first: maxPaginas, scale: ESCALA_OCR_PDF }),
      TIMEOUT_RASTER_MS,
      "Rasterizado PDF",
    );
    paginas = shot.pages ?? [];
  } catch (err) {
    console.error("[extraccion] no se pudo rasterizar el PDF para OCR:", err);
    return "";
  }
  const textos: string[] = [];
  for (const p of paginas) {
    const t = await leerImagen(Buffer.from(p.data));
    if (t) textos.push(t);
  }
  return textos.join("\n\n");
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
      try {
        const textoPdf = (await parser.getText()).text?.trim() ?? "";
        // pdf-parse solo lee la CAPA DE TEXTO del PDF. En muchas facturas el
        // EMISOR (logo + membrete, y a veces el texto vertical del lateral) va
        // como IMAGEN, no como texto: su nombre/NIF no aparece aquí y el único
        // nombre de empresa en el texto suele ser el del CLIENTE. Sin esto la IA
        // tomaba el cliente como emisor (caso real: una factura de "TRAZA
        // NOSITEC" a "AKX STUDIO" salía con emisor = AKX). Para recuperar ese
        // texto en imagen rasterizamos la página y le pasamos OCR, y lo
        // combinamos con la capa de texto:
        //  - PDF SIN texto (factura escaneada): OCR de las primeras páginas para
        //    recuperar TODO el contenido (antes de esto no se indexaba nada).
        //  - PDF que parece factura, trae texto, pero el emisor NO está en él: OCR
        //    solo de la 1ª página —donde está el membrete/logo— para completar el
        //    emisor sin duplicar el resto del documento.
        // CLAVE: si el texto YA trae la línea legal del emisor ("… Registro/Registre
        // Mercantil …"), el emisor ya está en la capa de texto y el OCR del membrete
        // solo METE RUIDO (visto: leer el logo "AKX" como "ARX", que luego confunde
        // la extracción de cliente y su clasificación venta/compra). En ese caso NO
        // se hace OCR de página: el texto limpio basta. TRAZA (emisor solo en la
        // imagen del pie; su línea de registro no está en la capa de texto) sí lo
        // dispara y sigue recuperando su emisor.
        let ocrTexto = "";
        const necesitaMembrete = pareceFacturaConImportes(textoPdf) && !tieneRegistroMercantil(textoPdf);
        if (!textoPdf || necesitaMembrete) {
          ocrTexto = await ocrPaginasPdf(parser, textoPdf ? 1 : MAX_PAGINAS_OCR_PDF);
        }
        return limpiar([textoPdf, ocrTexto].filter(Boolean).join("\n\n"));
      } finally {
        await parser.destroy();
      }
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

    // Imagen: OCR/descripción con el modelo de visión.
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
