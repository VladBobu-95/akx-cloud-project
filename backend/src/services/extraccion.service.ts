import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
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
  const data = (await res.json()) as {
    message?: { content?: string };
    error?: string;
    done?: boolean;
    done_reason?: string;
  };
  if (!res.ok || data.error || !data.message?.content) {
    // res.status solo no basta para diagnosticar: Ollama puede responder 200 con
    // el contenido vacío (ej. el modelo no llegó a generar nada por falta de
    // VRAM al tener que cargar otro modelo grande a la vez). done_reason ayuda a
    // distinguir ese caso de un error real de la API.
    throw new Error(
      `Modelo de visión (${modelo}) falló: status=${res.status} error=${data.error ?? "-"} done=${data.done ?? "-"} done_reason=${data.done_reason ?? "-"}`,
    );
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
  // solo tiene sentido si el texto original tenía etiquetas — granite a veces da
  // una respuesta corta pero válida sin ninguna etiqueta (ej. "Factura" ante un
  // documento denso que no llegó a transcribir), y esa NO es basura: descartarla
  // aquí le cortaba el paso a la escalada a deepseek-ocr, que es la que de verdad
  // tenía que leer la factura.
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

// deepseek-ocr transcribe las tablas de una factura como HTML (<table><td>...),
// pero pdf-parse (el otro origen posible de este mismo texto) nunca devuelve
// HTML, solo texto plano. Sin esto, el contenido guardado (lo que se ve al
// "abrir"/"leer" el archivo en el chat, lo que se indexa para RAG, y lo que se
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

// ¿El texto de la 1ª pasada parece una factura/recibo con importes? Es la señal
// para escalar al OCR especialista (deepseek-ocr), que no se equivoca con los
// dígitos. Una descripción de foto o un texto sin importes no lo dispara, así nos
// ahorramos la pasada lenta de deepseek en todo lo que no es factura.
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
  return /\bfactura\b|\biva\b|\bsubtotal\b|\bbase imponible\b|\brecibo\b/.test(t);
};

// ¿Lo que sacaron granite/deepseek se queda corto para ser un documento real?
// OJO: NO es solo "pocas palabras", ni basta con buscar una frase concreta EN
// CUALQUIER PARTE del texto — una buena descripción real de una foto sin texto
// también puede empezar con "La imagen presenta..." (forma normal de describir
// algo) o terminar con "No hay texto presente en la imagen" (el propio prompt le
// pide confirmarlo), sin que eso la convierta en basura. Si se descarta solo por
// contener esa frase, se pierde una respuesta buena y se dispara Tesseract sobre
// una foto sin nada que leer — que devuelve ruido aleatorio con MÁS "palabras"
// que la descripción buena, y ese ruido termina sustituyéndola (regresión real).
// Por eso:
//  - la meta-descripción ("habla SOBRE la estructura del documento citando los
//    NOMBRES de los campos, no sus valores": "incluye detalles como la fecha de
//    emisión...", "está dirigida a un cliente llamado...") se caza por frases
//    concretas de ESE patrón, no por cómo empieza la frase — esas frases no
//    aparecen en una descripción real de una foto;
//  - la negación de texto ("no hay texto...") solo cuenta si el RESTO de la
//    respuesta es corto — si va seguida de una descripción larga real, no es un
//    fallo, es la conclusión normal de una buena respuesta;
//  - y una respuesta de un puñado de palabras sueltas sin verbo/frase real (ej.
//    "Factura": reconoce el tipo de documento pero no llega a transcribirlo).
const METADESCRIPCION =
  /\b(detalles como|estructurad[oa] en formato|columnas para|secciones para|menciona que|se proporciona un|dirigid[oa] a un cliente llamado|relacionad[oa] con una factura)\b/i;
const NEGACION_TEXTO = /\bno\s+(hay|contiene|se\s+(ve|aprecia)|tiene)\b[^.]{0,30}\btexto\b/i;
const UMBRAL_MUY_CORTO = 4;
const UMBRAL_NEGACION = 15;
const pareceResultadoPobre = (texto: string): boolean => {
  const limpio = texto.trim();
  if (!limpio) return true;
  if (METADESCRIPCION.test(limpio)) return true;
  const palabras = limpio.split(/\s+/).filter(Boolean).length;
  if (NEGACION_TEXTO.test(limpio) && palabras < UMBRAL_NEGACION) return true;
  return palabras < UMBRAL_MUY_CORTO;
};

// Tesseract.js: OCR clásico (no es un LLM de visión), corre en CPU y no compite
// por la VRAM con Ollama. Es la red de seguridad final cuando ni granite ni
// deepseek-ocr consiguen leer un documento bien impreso y legible — los modelos
// de visión reescalan la imagen a una resolución de entrada fija internamente, y
// con texto denso/pequeño pierden legibilidad por el camino; Tesseract procesa la
// imagen a su tamaño real, así que es buen complemento justo donde esos modelos
// fallan (texto impreso, buen contraste). Al revés, es peor que ellos con fotos o
// fondos complejos — por eso va el último, no el primero, y solo se usa su
// resultado si de verdad aporta más que lo que ya había (ver ocrImagen).
let workerTesseract: Promise<Worker> | null = null;
const obtenerWorkerTesseract = (): Promise<Worker> => {
  if (!workerTesseract) workerTesseract = createWorker("spa");
  return workerTesseract;
};

// Preprocesado clásico de Tesseract: a diferencia de los modelos de visión (que
// reescalan la entrada a una resolución fija interna, ver aPng — el preprocesado
// no la sortea), Tesseract sí lee la imagen a su tamaño real. Gris (sin color que
// distraiga), más resolución si la imagen es pequeña (más píxeles por carácter
// en texto denso) y normalizar contraste mejoran la lectura en la práctica.
const ANCHO_MIN_TESSERACT = 2000;
const prepararParaTesseract = async (buffer: Buffer): Promise<Buffer> => {
  try {
    const { width = 0 } = await sharp(buffer).metadata();
    let imagen = sharp(buffer).grayscale().normalize();
    if (width > 0 && width < ANCHO_MIN_TESSERACT) {
      imagen = imagen.resize({ width: Math.round(width * (ANCHO_MIN_TESSERACT / width)) });
    }
    return await imagen.png().toBuffer();
  } catch (err) {
    console.error("[extraccion] no se pudo preprocesar la imagen para Tesseract, se usa tal cual:", err);
    return buffer;
  }
};

// Dos pasadas con distinto modo de segmentación de página (PSM), no una sola:
// probado con dos facturas reales, el modo automático (AUTO, el de por defecto)
// lee bien la mayoría del documento pero en una tabla con bordes puede saltarse
// FILAS ENTERAS (pasaba directo de la cabecera de la tabla al subtotal, sin
// ninguna línea de artículo); el modo "texto disperso" (SPARSE_TEXT) sí las
// recupera, pero pierde precisión en otras partes de OTRO documento (cantidades,
// algún dígito mal leído). Ningún modo gana siempre, así que se combinan los dos
// resultados en vez de escoger uno — la extracción de datos de factura (IA, más
// adelante) ya tolera texto redundante/ruidoso y se queda con los datos reales
// que encuentre en cualquiera de los dos.
const ocrConTesseract = async (buffer: Buffer): Promise<string> => {
  const worker = await obtenerWorkerTesseract();
  const preparado = await prepararParaTesseract(buffer);

  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  const auto = await worker.recognize(preparado);

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  const disperso = await worker.recognize(preparado);

  return `${auto.data.text ?? ""}\n\n${disperso.data.text ?? ""}`.trim();
};

// Refuerzo final por si el prompt de visionPrimeraPasada no basta: heurística
// simple para detectar que el texto cayó (total o parcialmente) en inglés, por
// densidad de stopwords inglesas muy comunes. OJO: granite a veces mezcla los
// dos idiomas en la misma frase ("La imagen muestra un árbol... under a clear
// blue sky"), así que NO se puede descartar inglés solo por encontrar una tilde
// suelta en otra parte del texto — eso dejaba pasar justo los casos mixtos que
// más interesa traducir. No es perfecta (frases cortas o muy técnicas pueden
// colar falsos positivos/negativos), pero es suficiente como red de seguridad
// antes de pagar una llamada extra de traducción.
const STOPWORDS_INGLES = /\b(the|and|with|this|that|is|are|was|were|has|have|of|in|on|its|an|to|for)\b/gi;
const pareceIngles = (texto: string): boolean => {
  const matches = texto.match(STOPWORDS_INGLES) ?? [];
  return matches.length >= 2;
};

// Traduce con el modelo de chat principal (OLLAMA_MODEL: más grande y mucho más
// obediente con instrucciones que el modelo de visión) solo cuando la heurística
// anterior detecta inglés. Si la llamada falla, se devuelve el texto original sin
// traducir en vez de perderlo.
const traducirAlEspanol = async (texto: string): Promise<string> => {
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages: [
          {
            role: "user",
            content: `Traduce el siguiente texto al español. Si ya está en español, devuélvelo exactamente igual. No añadas explicaciones ni comentarios.\n\n${texto}`,
          },
        ],
        stream: false,
        options: { temperature: 0 },
      }),
    });
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() || texto;
  } catch (err) {
    console.error("[extraccion] no se pudo traducir la descripción al español:", err);
    return texto;
  }
};

const asegurarEspanol = (texto: string): Promise<string> =>
  pareceIngles(texto) ? traducirAlEspanol(texto) : Promise.resolve(texto);

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
//   4. Si lo que queda hasta aquí es pobre (vacío, "Factura", "No hay texto"...),
//      se prueba Tesseract (CPU, sin tocar la GPU) como último recurso — visto en
//      la práctica: granite puede alucinar "no hay texto" ante una factura
//      perfectamente legible porque su entrada de visión tiene una resolución
//      fija y pierde el texto pequeño/denso por el camino; Tesseract no tiene
//      ese límite. Solo se adopta su resultado si de verdad aporta más texto que
//      lo que ya había (si también sale pobre, era de verdad una foto sin texto).
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
  primera = pareceBucleDegenerado(primera) ? "" : limpiarTablasHtml(primera.trim());

  let resultado = primera;
  if (env.OLLAMA_OCR_MODEL !== env.OLLAMA_CAPTION_MODEL && pareceFacturaConImportes(primera)) {
    try {
      const ocr = await ocrConOllama(buffer);
      if (ocr.trim() && !pareceBucleDegenerado(ocr)) resultado = limpiarTablasHtml(ocr.trim());
    } catch (err) {
      console.error("[extraccion] OCR especialista (2ª pasada) falló:", err);
    }
  }

  if (pareceResultadoPobre(resultado)) {
    try {
      const tess = await ocrConTesseract(buffer);
      if (!pareceResultadoPobre(tess)) resultado = limpiarTablasHtml(tess.trim());
    } catch (err) {
      console.error("[extraccion] Tesseract (3ª red) falló:", err);
    }
  }

  return await asegurarEspanol(resultado);
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
