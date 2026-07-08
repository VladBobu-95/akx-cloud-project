import { z } from "zod";
import { AppDataSource } from "../config/database";
import { env } from "../config/env";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { Empresa } from "../entities/Empresa";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";
import { AppError } from "../utils/errors";
import { combinarContenido } from "./archivos.service";
import { actualizarDescripcionManual } from "./rag.service";
import { pareceFacturaConImportes } from "./extraccion.service";
// Cola durable: encolarEscaneoManual encola aquí en vez de en la cola en memoria.
// (Import circular tareas<->facturas: ambos se usan solo dentro de funciones, no
// a nivel de módulo, así que se resuelve en runtime sin problema.)
import { encolarTarea, P_ALTA } from "./tareas.service";

// Contenido de la factura: el texto ya extraído (OCR/PDF/DOCX) combinado con
// la descripción manual del usuario, si la hay (ver `combinarContenido`). NO
// vuelve a lanzar el OCR aquí: el pipeline de subida (`indexarArchivo`) ya lo
// intentó siempre antes de llegar a este punto — repetirlo aquí solo duplicaba
// el coste de deepseek-ocr en imágenes sin texto real, sin ningún beneficio
// (mismo archivo, misma IA con temperature 0 → mismo resultado vacío otra vez).
// Añade la "pista" del usuario si la hay. Lanza si no consigue nada.
const leerContenidoFactura = (archivo: Archivo, pista?: string): string => {
  const texto = combinarContenido(archivo.textoExtraido, archivo.descripcionManual);
  const extra = pista?.trim() ? `\n\nINFO ADICIONAL DEL USUARIO: ${pista.trim()}` : "";
  const completo = (texto + extra).trim();
  if (!completo) {
    throw new AppError(
      422,
      "No pude leer el contenido del archivo. Indica qué contiene (pista).",
    );
  }
  return completo;
};

// --- Extracción estructurada con la IA ---
export interface DatosFactura {
  numero?: string;
  archivoNombre?: string;
  fecha?: string;
  emisor?: string;
  cliente?: string;
  // NIF/CIF de cada parte. Se piden a la IA (y se refuerzan con reconciliarPartes)
  // porque son la señal MÁS fiable para (a) no confundir emisor con cliente y (b)
  // decidir después si la factura es venta o compra anclando en el CIF del tenant
  // (ver resolverDireccion). Los nombres de empresa varían mucho entre facturas
  // ("AKX STUDIO, S.L." / "AKX Studio SLU" / "AKX ESTUDIO S.L."), el CIF no.
  emisorNif?: string;
  clienteNif?: string;
  moneda?: string;
  subtotal?: number;
  iva?: number;
  total?: number;
  lineas?: { descripcion: string; cantidad?: number; precioUnit?: number; total?: number }[];
}

// JSON schema que se le pasa a Ollama (format) para forzar una salida estructurada.
const SCHEMA_FACTURA = {
  type: "object",
  properties: {
    numero: { type: "string" },
    fecha: { type: "string" },
    emisor: { type: "string" },
    emisorNif: { type: "string" },
    cliente: { type: "string" },
    clienteNif: { type: "string" },
    moneda: { type: "string" },
    subtotal: { type: "number" },
    iva: { type: "number" },
    total: { type: "number" },
    lineas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          descripcion: { type: "string" },
          cantidad: { type: "number" },
          precioUnit: { type: "number" },
          total: { type: "number" },
        },
        required: ["descripcion"],
      },
    },
  },
  // NO se marca ningún campo como required: con la decodificación restringida de
  // Ollama, exigir todos los campos obliga al modelo a INVENTAR valores cuando el
  // texto no los tiene (una foto sin factura salía como factura completa). Dejándolos
  // opcionales, la IA puede devolver lo que de verdad encuentre (o nada), y la guarda
  // de `escanearFactura` decide si hay datos suficientes para ser una factura.
  required: [],
};

const extraerDatosFactura = async (contenido: string): Promise<DatosFactura> => {
  const messages = [
    {
      role: "system",
      content:
        "Extrae TODOS los datos de la factura del texto y devuélvelos en JSON. Rellena: numero (nº de factura), fecha (ISO YYYY-MM-DD), emisor (quién la emite y cobra), emisorNif (su NIF/CIF/VAT), cliente (a quién se factura), clienteNif (su NIF/CIF/VAT), moneda (código ISO de 3 letras de la divisa de los importes: EUR para € o euros, USD para $ o dólares, GBP para £ o libras, etc.; si no se indica ninguna, usa EUR), subtotal, iva, total, y lineas (un objeto por artículo: descripcion, cantidad, precioUnit, total). " +
        "IMPORTANTE para distinguir emisor de cliente: el EMISOR es la empresa que EMITE y COBRA la factura; suele ir con su logo/membrete en la cabecera o en la línea legal del pie ('… inscrita en el Registro Mercantil …', con su CIF). El CLIENTE es el DESTINATARIO al que se factura; suele ir bajo un rótulo como 'Datos del cliente', 'Datos de facturación', 'Nombre titular', 'A/A' o 'A la atención de', junto a su dirección. El emisor NUNCA es el destinatario de esa dirección. Son empresas DISTINTAS con NIF distinto. " +
        "Rellena TODOS los campos que aparezcan en el texto; no dejes vacío lo que sí está. Los importes como números, sin símbolo de moneda. No inventes datos que no aparezcan.",
    },
    { role: "user", content: contenido },
  ];
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        stream: false,
        format: SCHEMA_FACTURA,
        // num_ctx explícito: el contexto por defecto de Ollama (2048/4096 según
        // versión) TRUNCA en silencio una factura larga — `textoExtraido` llega
        // hasta ~20k chars (≈6-7k tokens) y `leerContenidoFactura` no lo recorta,
        // así que sin esto las líneas/totales del final de una factura densa se
        // perdían. 8192 cubre el texto completo + el JSON de salida de muchas líneas.
        // keep_alive mantiene qwen cargado entre facturas de un mismo lote (escanear
        // 40 de golpe) en vez de descargarlo y recargarlo en cada una.
        options: { temperature: 0, num_ctx: 8192 },
        keep_alive: "10m",
      }),
      // Timeout para no colgarse si Ollama no libera VRAM para cargar el modelo
      // de chat (ver OLLAMA_TIMEOUT_MS): mejor un 503 reintentable que dejar el
      // archivo eternamente en "escaneando".
      signal: AbortSignal.timeout(env.OLLAMA_TIMEOUT_MS),
    });
  } catch {
    throw new AppError(503, "No se puede conectar con la IA para procesar la factura.");
  }
  const data = (await res.json()) as { message?: { content?: string }; error?: string };
  if (!res.ok || data.error || !data.message?.content) {
    throw new AppError(503, `La IA no pudo procesar la factura: ${data.error ?? res.status}`);
  }
  try {
    return JSON.parse(data.message.content) as DatosFactura;
  } catch {
    throw new AppError(503, "La IA devolvió un formato inesperado al leer la factura.");
  }
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const redondear2 = (n: number): number => Math.round(n * 100) / 100;

// Tipos de IVA vigentes en España (general 21 %, reducido 10 %, superreducido 4 %).
// Se usan para validar una inferencia de IVA antes de aceptarla (ver conciliarImportes).
const TIPOS_IVA = [0.21, 0.1, 0.04];

// Concilia los importes que el modelo dejó vacíos o a 0 a partir de los demás,
// con la aritmética de una factura (líneas → subtotal; subtotal + iva = total).
// Clave: SOLO rellena huecos, nunca sobreescribe un valor que el modelo sí
// extrajo — recalcular sobre un importe ya presente podría EMPEORAR una
// extracción correcta si una sola línea se leyó mal (perder precisión es justo
// lo que queremos evitar). Rellenar lo ausente es seguro y solo añade datos.
const conciliarImportes = (datos: DatosFactura): void => {
  // 1. Por línea: completar total = cantidad × precioUnit, o al revés.
  for (const l of datos.lineas ?? []) {
    const cantidad = num(l.cantidad);
    const precioUnit = num(l.precioUnit);
    const total = num(l.total);
    if (total <= 0 && cantidad > 0 && precioUnit > 0) {
      l.total = redondear2(cantidad * precioUnit);
    } else if (precioUnit <= 0 && cantidad > 0 && total > 0) {
      l.precioUnit = redondear2(total / cantidad);
    }
  }
  // 2. subtotal = Σ(líneas.total), solo si falta y hay líneas con importe.
  const sumaLineas = redondear2(
    (datos.lineas ?? []).reduce((acc, l) => acc + num(l.total), 0),
  );
  if (num(datos.subtotal) <= 0 && sumaLineas > 0) datos.subtotal = sumaLineas;
  // 3. Completar el importe global que falte a partir de los otros dos.
  const subtotal = num(datos.subtotal);
  const iva = num(datos.iva);
  const total = num(datos.total);
  if (total <= 0 && subtotal > 0) {
    datos.total = redondear2(subtotal + iva);
  } else if (subtotal <= 0 && total > 0) {
    datos.subtotal = redondear2(total - iva);
  } else if (iva <= 0 && total > 0 && subtotal > 0 && total > subtotal) {
    // iva ausente y el total supera al subtotal: la diferencia PODRÍA ser el IVA,
    // pero solo lo aceptamos si el tipo implícito (diferencia / subtotal) encaja
    // con un tipo estándar español (21/10/4 %), con ±1 punto de margen para
    // redondeos. Si no encaja, lo dejamos en 0 en vez de inventar: es el caso de
    // las facturas con retención de IRPF (total = base + IVA − IRPF), donde
    // total − subtotal NO es el IVA, o de cualquier otro ajuste no estándar.
    const diferencia = redondear2(total - subtotal);
    const tipoImplicito = diferencia / subtotal;
    if (TIPOS_IVA.some((t) => Math.abs(tipoImplicito - t) <= 0.01)) {
      datos.iva = diferencia;
    }
  }
};

// Todas las lecturas numéricas plausibles de un token del texto ("1.234,56",
// "50.00", "1,0000"...). Se devuelven TODAS las interpretaciones razonables (todos
// los separadores como miles, y el último separador como decimal) para no
// descartar un importe correcto por una ambigüedad de formato español/inglés.
const interpretacionesNumericas = (token: string): number[] => {
  const out = new Set<number>();
  const soloDigitos = token.replace(/[.,]/g, ""); // todos los separadores = miles
  if (soloDigitos) out.add(Number(soloDigitos));
  const m = /^(.*)[.,](\d+)$/.exec(token); // último separador = decimal
  if (m) out.add(Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`));
  const plano = Number(token);
  if (Number.isFinite(plano)) out.add(plano);
  return [...out].filter((n) => Number.isFinite(n));
};

// Valores que aparecen en el texto EN CONTEXTO MONETARIO (un importe de verdad),
// para verificar que los importes de la IA existen y no se los ha inventado. NO
// vale cualquier número: un nº de RMA ("RMA: 2.025/SAT/542"), un NIF, un código
// de cliente o una fecha NO son importes, y aceptarlos dejaba colar un importe
// inventado que por casualidad coincide con uno de ellos (visto: total "2.025,00 €"
// validado contra el RMA 2.025). Solo cuenta un número si:
//  (a) trae céntimos explícitos —exactamente 2 decimales— ("141,60", "2.025,00",
//      "50.00"): la forma normal de un importe; el `(?!\d)` descarta "2.025" (3
//      dígitos tras el punto = miles, no céntimos) y "1,0000" (cantidad), y
//  (b) va pegado a un símbolo/nombre de moneda ("€ 120", "120€", "120 EUR"), que
//      cubre los importes enteros sin céntimos.
const MONEDA_RE = "[€$£¥]|\\b(?:eur|usd|gbp|jpy|chf|euros?|d[óo]lares?|libras?|yenes?)\\b";
const numerosMonetariosDelTexto = (texto: string): number[] => {
  const out: number[] = [];
  for (const m of texto.matchAll(/\d[\d.,]*[.,]\d{2}(?!\d)/g)) {
    out.push(...interpretacionesNumericas(m[0]));
  }
  const conMoneda = new RegExp(
    `(?:${MONEDA_RE})\\s*(\\d[\\d.,]*)|(\\d[\\d.,]*)\\s*(?:${MONEDA_RE})`,
    "gi",
  );
  for (const m of texto.matchAll(conMoneda)) {
    const tok = m[1] ?? m[2];
    if (tok) out.push(...interpretacionesNumericas(tok));
  }
  return out;
};

// Descarta (pone a 0) los importes que la IA devolvió pero que NO están en el texto
// del documento: son inventados. Caso real: una factura de devolución con los
// importes en blanco (solo el símbolo "€" sin número) — el modelo, al pedírsele que
// rellene todos los campos, se saca de la nada base/IVA/total. Al vaciarlos aquí,
// ANTES de la guarda de escanearFactura, la factura sin importes legibles se trata
// como "no_factura" en vez de guardarse con cifras falsas. Deliberadamente permisivo
// (ver interpretacionesNumericas): solo borra lo que no coincide con NINGUNA lectura
// del texto, para no tocar un importe correcto por un tema de formato. Lo que la
// aritmética pueda derivar (subtotal+iva=total…) lo recompone después
// conciliarImportes a partir de lo que sí es real.
const verificarImportesReales = (datos: DatosFactura, contenido: string): void => {
  const presentes = numerosMonetariosDelTexto(contenido);
  const enTexto = (v?: number): boolean => {
    const n = num(v);
    return n > 0 && presentes.some((p) => Math.abs(p - n) <= 0.01);
  };
  for (const l of datos.lineas ?? []) {
    if (!enTexto(l.precioUnit)) l.precioUnit = 0;
    if (!enTexto(l.total)) l.total = 0;
  }
  if (!enTexto(datos.subtotal)) datos.subtotal = 0;
  if (!enTexto(datos.iva)) datos.iva = 0;
  if (!enTexto(datos.total)) datos.total = 0;
};

// --- Reconciliación determinista de emisor/cliente ---
// El modelo pequeño confunde emisor y cliente: en muchas facturas el emisor va en
// el logo/membrete (imagen) y el ÚNICO nombre en la capa de texto es el del
// cliente, así que el modelo lo toma como emisor (caso real: factura de "TRAZA
// NOSITEC" a "AKX" salía con emisor=AKX y cliente=TRAZA, invertidos). Aquí se
// corrige con una señal FIABLE y presente en casi toda factura española: el
// emisor es la empresa que aparece en la línea legal "… inscrita en el Registro
// Mercantil …". Es conservador: solo actúa cuando detecta un conflicto claro (el
// cliente del modelo coincide con esa empresa, o el emisor falta/está duplicado),
// nunca toca una extracción ya coherente.

// Sufijos societarios españoles, para reconocer un nombre de empresa y para poder
// quitarlos al comparar dos nombres (el mismo sale con/sin sufijo entre facturas).
const SUFIJO_SOCIETARIO = /\b(?:s\.?l\.?u\.?|s\.?l\.?n\.?e\.?|s\.?l\.?|s\.?a\.?u\.?|s\.?a\.?|s\.?c\.?|s\.?coop\.?|s\.?l\.?l\.?)\b/gi;

// Normaliza un nombre de empresa para comparar: sin tildes, minúsculas, sin
// sufijo societario ni puntuación, espacios colapsados. Además unifica la
// variante OCR/tipográfica "estudio"↔"studio" (AKX sale como ambas).
const normalizarNombreEmpresa = (s?: string | null): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(SUFIJO_SOCIETARIO, " ")
    .replace(/\bestudio\b/g, "studio")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ¿Dos nombres se refieren a la misma empresa? Igualdad tras normalizar, o que
// todos los tokens significativos (≥3 letras) del más corto estén en el más
// largo — cubre "AKX Studio" vs "AKX Studio SLU Montsià 15 bis" sin casar por un
// token genérico suelto.
const mismaEmpresa = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" ").filter((t) => t.length >= 3);
  const tb = b.split(" ").filter((t) => t.length >= 3);
  if (ta.length === 0 || tb.length === 0) return false;
  const [corto, largo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const setLargo = new Set(largo);
  return corto.every((t) => setLargo.has(t));
};

// ¿Dos nombres comparten algún token distintivo (≥4 letras)? Más laxo que
// mismaEmpresa: sirve para detectar que emisor y cliente son "el mismo" pese a
// una lectura OCR ligeramente distinta —p. ej. el modelo saca emisor "AKX Studio"
// y cliente "ARX Studio" (K↔R del logo): comparten "studio"—. No casa por un
// token corto/genérico (evita falsos positivos con "S.L."/"the").
const compartenTokenDistintivo = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const ta = new Set(a.split(" ").filter((t) => t.length >= 4));
  return b.split(" ").some((t) => t.length >= 4 && ta.has(t));
};

// Localiza la empresa emisora (nombre + NIF) por la línea legal del pie: la razón
// social suele ir justo ANTES de "… inscrita en el Registro Mercantil …", con su
// NIF a continuación ("… NIF B39540760"). Busca un nombre con sufijo societario en
// la ventana previa y un NIF en la ventana posterior. Devuelve null si no la
// encuentra (factura extranjera, o la razón social va lejos de la frase).
// `registr[eo]`/`rexistr[eo]` cubren también el catalán ("Registre Mercantil") y
// el gallego ("Rexistro Mercantil") — sin esto, una factura de la luz en catalán
// (Repsol) traía el emisor solo en el pie pero no se anclaba por la ortografía.
const RE_REGISTRO_MERCANTIL = /(?:inscrit[ao]\b[^\n]{0,40}?)?re[gx]istr[eo]\s+mercantil/i;
const RE_EMPRESA_CON_SUFIJO =
  /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][\wÁÉÍÓÚÜÑáéíóúüñ.,&'’ -]{1,60}?\b(?:S\.?L\.?U?\.?|S\.?A\.?U?\.?|S\.?C\.?|S\.?COOP\.?))/gi;
// NIF/CIF español: una letra + 7-8 dígitos (CIF, ej. B39540760) o 8 dígitos + letra (DNI/NIE).
const RE_NIF = /\b([A-Z]-?\d{7,8}|\d{8}-?[A-Z])\b/;
const emisorPorRegistroMercantil = (
  contenido: string,
): { nombre: string; nif?: string } | null => {
  const m = RE_REGISTRO_MERCANTIL.exec(contenido);
  if (!m) return null;
  const ventanaPrev = contenido.slice(Math.max(0, m.index - 140), m.index);
  const matches = [...ventanaPrev.matchAll(RE_EMPRESA_CON_SUFIJO)];
  if (matches.length === 0) return null;
  const nombre = matches[matches.length - 1][1].replace(/\s+/g, " ").trim();
  // NIF del emisor: normalmente justo tras la frase ("… Registre Mercantil … NIF Bxxxx").
  const nifM = RE_NIF.exec(contenido.slice(m.index, m.index + 140));
  return { nombre, nif: nifM ? nifM[1] : undefined };
};

// Corrige emisor/cliente si están invertidos o el emisor está duplicado/ausente,
// anclando en la empresa de la línea "Registro Mercantil". No lanza nunca. Muta
// `datos` in situ (nombre y NIF de emisor/cliente). Exportada para tests.
export const reconciliarPartes = (datos: DatosFactura, contenido: string): void => {
  const reg = emisorPorRegistroMercantil(contenido);
  const nReg = normalizarNombreEmpresa(reg?.nombre);
  if (!nReg) return; // sin ancla fiable, no tocamos la salida del modelo
  const nEmisor = normalizarNombreEmpresa(datos.emisor);
  const nCliente = normalizarNombreEmpresa(datos.cliente);

  if (nEmisor && mismaEmpresa(nEmisor, nReg)) return; // ya es correcto

  if (nCliente && mismaEmpresa(nCliente, nReg)) {
    // El modelo puso el emisor real como cliente → invertidos: se intercambian
    // (nombre y NIF). Un cliente jamás aparece en la línea de Registro Mercantil
    // del emisor, así que la señal es inequívoca.
    [datos.emisor, datos.cliente] = [datos.cliente, datos.emisor];
    [datos.emisorNif, datos.clienteNif] = [datos.clienteNif, datos.emisorNif];
    return;
  }

  // Emisor ausente o duplicado con el cliente (típico de una factura de la luz: el
  // único nombre en el texto es el del cliente y el modelo lo pone en ambos lados).
  // Se fija con el nombre + NIF del pie legal. El emisorNif del modelo era en
  // realidad del cliente, así que se sustituye por el del registro (o se borra si
  // no lo hay) para no dejar el CIF del cliente como si fuera el del emisor.
  // `compartenTokenDistintivo` cubre el caso en que el OCR leyó emisor y cliente
  // con una pequeña diferencia ("AKX Studio" vs "ARX Studio") y mismaEmpresa no
  // los ve iguales — sin él, el emisor real (Repsol) no se ancla en esas lecturas.
  if (!nEmisor || (nCliente && (mismaEmpresa(nEmisor, nCliente) || compartenTokenDistintivo(nEmisor, nCliente)))) {
    datos.emisor = reg!.nombre;
    datos.emisorNif = reg!.nif;
  }
};

// --- Dirección de la factura: venta vs compra ---
// Normaliza un NIF/CIF para comparar: mayúsculas y sin separadores ("B-13861935",
// "b13861935", "ES B13861935" → "B13861935"; el prefijo VAT "ES" se conserva pero
// como los dos lados se normalizan igual, no estorba la comparación de igualdad).
const normalizarNif = (s?: string | null): string =>
  (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ¿Aparece el NIF `nifNorm` (ya normalizado) EN EL TEXTO del documento? Escanea
// todos los NIF/CIF plausibles del texto y los compara normalizados. Sirve para el
// caso en que el CIF del tenant está en la factura pero el modelo no lo puso en el
// campo cliente (típico si el OCR destrozó el nombre del cliente).
const RE_NIF_GLOBAL = /\b([A-Za-z]-?\d{7,8}|\d{8}-?[A-Za-z])\b/g;
const contenidoIncluyeNif = (contenido: string, nifNorm: string): boolean => {
  if (!nifNorm) return false;
  for (const m of contenido.matchAll(RE_NIF_GLOBAL)) {
    if (normalizarNif(m[1]) === nifNorm) return true;
  }
  return false;
};

// Decide si la factura es una VENTA (la empresa del propietario es el emisor) o una
// COMPRA (es el cliente), anclando primero en el CIF de la empresa (fiable) y, si no
// se conoce, en el parecido de nombre. El CIF de la empresa lo aprende por separado
// intentarAprenderCifEmpresa (por corroboración), no aquí.
type Direccion = "venta" | "compra" | "desconocido";
// Exportada para tests (unidad, sin BD ni IA).
export const resolverDireccion = (
  datos: DatosFactura,
  empresa?: Empresa | null,
  contenido = "",
): Direccion => {
  const empresaNif = normalizarNif(empresa?.nif);
  const emisorNif = normalizarNif(datos.emisorNif);
  const clienteNif = normalizarNif(datos.clienteNif);

  // Degenerado: si emisor y cliente son la MISMA empresa (el modelo no pudo
  // separarlos, típico cuando el nombre del emisor va solo en el logo y no en el
  // texto, ej. una factura de la luz), no se puede decidir venta/compra → queda
  // fuera de ambas analíticas en vez de contar como una venta falsa.
  const nEmi = normalizarNombreEmpresa(datos.emisor);
  const nCli = normalizarNombreEmpresa(datos.cliente);
  if (nEmi && nCli && mismaEmpresa(nEmi, nCli)) return "desconocido";

  // 1. Por CIF (inequívoco) si lo conocemos.
  if (empresaNif) {
    if (emisorNif && emisorNif === empresaNif) return "venta";
    if (clienteNif && clienteNif === empresaNif) return "compra";
    // El CIF del tenant está en el texto (aunque el modelo no lo capturara en el
    // campo cliente) y el emisor es OTRA empresa → el tenant es el cliente → compra.
    if (emisorNif && emisorNif !== empresaNif && contenidoIncluyeNif(contenido, empresaNif)) {
      return "compra";
    }
  }

  // 2. Por nombre contra empresa.nombre. Solo si casa EXACTAMENTE uno de los dos
  //    lados (si casan ambos o ninguno, es ambiguo → desconocido).
  const nEmpresa = normalizarNombreEmpresa(empresa?.nombre);
  if (nEmpresa) {
    const emisorEsEmpresa = mismaEmpresa(nEmpresa, nEmi);
    const clienteEsEmpresa = mismaEmpresa(nEmpresa, nCli);
    if (emisorEsEmpresa && !clienteEsEmpresa) return "venta";
    if (clienteEsEmpresa && !emisorEsEmpresa) return "compra";
  }

  return "desconocido";
};

// Aprende el CIF de la empresa por CORROBORACIÓN: mira el NIF del lado del tenant
// en sus facturas ya clasificadas (clienteNif en compras, emisorNif en ventas) y
// fija empresa.nif cuando uno se repite en ≥2 facturas. Así un NIF mal leído en una
// sola factura (p. ej. una devolución con un NIF raro en la cabecera) no se cuela, y
// no hace falta descartar los "swaps" (el CIF bueno acaba ganando por repetición).
// Best-effort: se llama tras guardar cada factura si la empresa aún no tiene CIF.
const MIN_CORROBORACION_CIF = 2;
const intentarAprenderCifEmpresa = async (empresaId: string): Promise<void> => {
  const repo = AppDataSource.getRepository(Empresa);
  const empresa = await repo.findOneBy({ id: empresaId });
  if (!empresa || empresa.nif) return; // ya lo tiene, o no existe
  const filas: { nif: string; n: number }[] = await AppDataSource.query(
    `SELECT nif, COUNT(*)::int AS n FROM (
       SELECT UPPER(REGEXP_REPLACE(COALESCE(
                CASE WHEN f."tipo" = 'compra' THEN f."clienteNif"
                     WHEN f."tipo" = 'venta'  THEN f."emisorNif" END, ''),
                '[^A-Za-z0-9]', '', 'g')) AS nif
       FROM "facturas" f
       JOIN "usuarios" u ON u."id" = f."propietarioId"
       WHERE u."empresaId" = $1
     ) t
     WHERE nif <> ''
     GROUP BY nif
     ORDER BY n DESC
     LIMIT 1`,
    [empresaId],
  );
  const top = filas[0];
  if (top && Number(top.n) >= MIN_CORROBORACION_CIF) {
    await repo.update(empresaId, { nif: top.nif });
  }
};

// Símbolos/nombres de moneda más comunes → código ISO 4217. La IA ya devuelve
// normalmente el código (se lo pedimos en el prompt), pero blindamos por si
// devuelve el símbolo ("$") o el nombre ("dólares"), o nada.
const ALIAS_MONEDA: Record<string, string> = {
  "€": "EUR", EUR: "EUR", EURO: "EUR", EUROS: "EUR",
  $: "USD", USD: "USD", US$: "USD", DOLAR: "USD", DOLARES: "USD", DÓLAR: "USD", DÓLARES: "USD",
  "£": "GBP", GBP: "GBP", LIBRA: "GBP", LIBRAS: "GBP",
  "¥": "JPY", JPY: "JPY", YEN: "JPY", YENES: "JPY",
  CHF: "CHF", FRANCO: "CHF", FRANCOS: "CHF",
  MXN: "MXN", PESO: "MXN", PESOS: "MXN",
  ARS: "ARS", COP: "COP", CLP: "CLP", BRL: "BRL", REAL: "BRL", REALES: "BRL",
  CAD: "CAD", AUD: "AUD", CNY: "CNY", YUAN: "CNY",
};

// Normaliza la divisa a un código ISO 4217 de 3 letras válido. Si no se reconoce
// o no es un código que `Intl.NumberFormat` sepa formatear, cae a EUR (la moneda
// por defecto de toda la app). Así `dinero()` nunca recibe una divisa inválida.
const normalizarMoneda = (m?: string): string => {
  const raw = (m ?? "").trim();
  if (!raw) return "EUR";
  const clave = raw.toUpperCase();
  const alias = ALIAS_MONEDA[raw] ?? ALIAS_MONEDA[clave];
  if (alias) return alias;
  // Código de 3 letras desconocido pero con pinta de ISO: lo aceptamos solo si
  // Intl lo reconoce como divisa (evita guardar basura como "ABC").
  if (/^[A-Z]{3}$/.test(clave)) {
    try {
      new Intl.NumberFormat("es-ES", { style: "currency", currency: clave }).format(1);
      return clave;
    } catch {
      return "EUR";
    }
  }
  return "EUR";
};

// Normaliza la fecha a ISO (YYYY-MM-DD); admite dd/mm/aaaa. null si no es válida.
const normalizarFecha = (f?: string): string | null => {
  if (!f) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(f);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
};

// Formato monetario español legible POR DIVISA: separador de miles (.), coma
// decimal y el símbolo de la moneda en su sitio, p. ej. (1234.5, "EUR") →
// "1.234,50 €" y (1234.5, "USD") → "1.234,50 US$". Un Intl.NumberFormat por
// moneda, cacheado (crearlos es caro y se llaman en bucles de rankings/listados).
// `moneda` ya viene normalizada a ISO por normalizarMoneda al guardar, pero si
// llegara una inválida no rompemos: número con el código detrás (p. ej. "1.234,50 ABC").
const fmtPorMoneda = new Map<string, Intl.NumberFormat>();
const dinero = (n: number | string, moneda = "EUR"): string => {
  const cod = moneda || "EUR";
  let fmt = fmtPorMoneda.get(cod);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: cod,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      fmt = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    fmtPorMoneda.set(cod, fmt);
  }
  const txt = fmt.format(Number(n) || 0);
  // Si el código no era una divisa válida, Intl no añade símbolo: lo ponemos nosotros.
  return /[^\d.,\s-]/.test(txt) ? txt : `${txt} ${cod}`;
};

// Etiqueta legible de una divisa para los encabezados de sección (solo se usan
// cuando hay más de una moneda). El símbolo entre paréntesis lo da el propio
// formateador de 0 (Intl), así no mantenemos otra tabla de símbolos a mano.
const NOMBRES_MONEDA: Record<string, string> = {
  EUR: "Euros", USD: "Dólares", GBP: "Libras", JPY: "Yenes",
  CHF: "Francos suizos", MXN: "Pesos mexicanos", BRL: "Reales", CNY: "Yuanes",
  CAD: "Dólares canadienses", AUD: "Dólares australianos",
};
export const nombreMoneda = (m: string): string => NOMBRES_MONEDA[m] ?? m;

// Formato de cantidades (unidades): separador de miles, sin decimales forzados,
// p. ej. 1500 → "1.500", 2.5 → "2,5".
const fmtNum = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const unidadesMd = (n: number | string): string => fmtNum.format(Number(n) || 0);

// Monedas distintas presentes en un conjunto de filas, preservando orden de aparición.
const monedasDistintas = <T extends { moneda: string }>(filas: T[]): string[] =>
  [...new Set(filas.map((f) => f.moneda))];

// Sanea un texto libre (cliente/emisor/producto/descripción) antes de meterlo en
// una celda de tabla o línea de lista markdown: colapsa saltos de línea y espacios,
// cambia el `|` por `/` (un `|` partiría la columna) y acota la longitud. Así un
// valor mal extraído por la IA —p. ej. un `cliente` con nombre+email+teléfono
// pegados o con un salto de línea dentro, típico del modelo pequeño— no rompe la
// estructura de la tabla del chat.
const celdaMd = (texto: string | number | null | undefined, max = 80): string => {
  const limpio = String(texto ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
};

// Formatea una fecha ISO (YYYY-MM-DD) como DD/MM/YYYY para mostrar al usuario.
export const formatearFecha = (iso: string): string => {
  const [anio, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${anio}`;
};

// Serializa tareas por usuario: las que llegan para el mismo usuario se
// encadenan en vez de correr a la vez. Exportada (como `enSerieFacturas`) para
// que carpetas.service.ts encole en esta MISMA cola las operaciones bulk sobre
// carpetas/archivos del usuario (vaciar/mover/borrar), y no compitan entre sí.
// (Estado en memoria: válido para una sola instancia de API, como es el caso.)
const colasPorUsuario = new Map<string, Promise<unknown>>();
const enSerie = <T>(usuarioId: string, tarea: () => Promise<T>): Promise<T> => {
  const anterior = colasPorUsuario.get(usuarioId) ?? Promise.resolve();
  // .then(tarea, tarea): se ejecuta tanto si la anterior fue ok como si falló.
  const actual = anterior.then(tarea, tarea);
  // Guardamos una versión "tragada" para que un fallo no rompa la cadena.
  colasPorUsuario.set(usuarioId, actual.catch(() => {}));
  return actual;
};
export const enSerieFacturas = enSerie;

// NOTA: la antigua cola en memoria (colaOcr/colaExtraccion/procesarColas) se
// sustituyó por la COLA DURABLE en Postgres (tareas.service.ts), que sobrevive
// a reinicios, reintenta con backoff y limita la concurrencia hacia Ollama. El
// agrupado por fases (evitar que Ollama cambie de modelo por archivo: OCR de
// imágenes con deepseek vs. extracción con qwen, que no caben juntos en la GPU)
// se conserva allí mediante las prioridades P_TEXTO/P_OCR/P_IMG_SCAN.

// --- API pública del servicio ---

// Escanea una factura (PDF/imagen), guarda los datos en BD y genera los resúmenes.
// opts.soloSiFactura: para el auto-escaneo al subir; si el archivo no parece una
// factura (sin líneas ni importes), no guarda nada y devuelve { omitida: true }.
export const escanearFactura = async (
  usuarioId: string,
  archivoId: string,
  opts: { pista?: string; soloSiFactura?: boolean } = {},
): Promise<{ numero?: string; total?: number; lineas: number; resumen: string; omitida?: boolean }> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivo = await archivoRepo.findOne({
    where: { id: archivoId },
    // La empresa del propietario (tenant) es el ancla para clasificar venta/compra.
    relations: { propietario: { empresa: true } },
  });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso sobre este archivo");
  }

  await archivoRepo.update(archivo.id, { estadoEscaneo: "escaneando" });
  try {
    const contenido = leerContenidoFactura(archivo, opts.pista);
    // Gate previo a la IA: solo extraemos si el contenido tiene ALGUNA señal de
    // factura (importes/palabras clave/dígitos). El SCHEMA_FACTURA marca todos
    // los campos como required, así que la decodificación restringida de Ollama
    // FUERZA al modelo a rellenarlos aunque el texto sea la descripción de una
    // foto sin facturas — y entonces inventa emisor/cliente/importes de la nada
    // (visto en producción: una foto de unos materiales salía como "Factura 1,
    // Empresa S.A., 141.60 €"). Si no parece factura, no llamamos a la IA y
    // dejamos que la guarda de abajo lo trate como "no_factura".
    const datos: DatosFactura = pareceFacturaConImportes(contenido)
      ? await extraerDatosFactura(contenido)
      : { lineas: [] };
    datos.archivoNombre = archivo.nombre;

    // Anti-invención: vacía los importes que la IA devolvió pero que no están en
    // el texto del documento (los inventa cuando la factura los trae en blanco,
    // p. ej. una devolución con solo el símbolo "€" sin número). Va ANTES de la
    // guarda de abajo, para que una factura sin importes legibles caiga como
    // "no_factura" en lugar de guardarse con cifras falsas.
    verificarImportesReales(datos, contenido);

    // Corrige emisor/cliente si el modelo los invirtió o duplicó, anclando en la
    // línea legal "Registro Mercantil" del documento (ver reconciliarPartes). Va
    // antes de la guarda para que la identificación (emisor) se evalúe ya corregida.
    reconciliarPartes(datos, contenido);

    // ¿Parece una factura real? Exige TANTO un importe real (no solo líneas con
    // descripción: el modelo puede inventarse precios para algo que no es una
    // factura, ej. una lista de la compra) COMO algún dato identificativo
    // (número/fecha/emisor) — así no se guarda una factura inventada por la IA
    // a partir de cualquier PDF/imagen subido (la app admite subir de todo,
    // no solo facturas).
    const lineasConImporte = (datos.lineas ?? []).filter(
      (l) => l.descripcion?.trim() && (Number(l.total) > 0 || Number(l.precioUnit) > 0),
    );
    const tieneImportes =
      Number(datos.total) > 0 || Number(datos.subtotal) > 0 || lineasConImporte.length > 0;
    const tieneIdentificacion = !!(
      datos.numero?.trim() ||
      datos.fecha?.trim() ||
      datos.emisor?.trim()
    );
    // Factura legítima de importe 0 (p. ej. una devolución/RMA sin cargo: el PDF
    // trae los importes en blanco —solo el símbolo "€" sin número— y
    // verificarImportesReales los dejó a 0 arriba). Sin esto caería como
    // "no_factura" pese a ser una factura real. Solo se acepta con una señal
    // FUERTE e inequívoca —el texto dice literalmente "factura" Y la IA sacó nº
    // + (fecha o emisor)— para no abrir la puerta a que cualquier PDF con un
    // número suelto cuele como factura de 0 €.
    const señalFuerteFactura =
      /\b(?:factura|invoice|rebut)\b/i.test(contenido) &&
      !!datos.numero?.trim() &&
      (!!datos.fecha?.trim() || !!datos.emisor?.trim());
    if ((!tieneImportes && !señalFuerteFactura) || !tieneIdentificacion) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "no_factura" });
      // Si un escaneo anterior llegó a guardar una factura (inventada) para este
      // archivo, ahora que sabemos que NO es factura la eliminamos: si no, seguiría
      // apareciendo en "abre X" y en la analítica pese a este resultado. Al
      // borrar la fila desaparece de la analítica sola (los resúmenes se generan
      // al vuelo desde la BD, no hay ningún .md que actualizar).
      await AppDataSource.getRepository(Factura)
        .createQueryBuilder()
        .delete()
        .where(`"archivoId" = :a AND "propietarioId" = :u`, { a: archivo.id, u: usuarioId })
        .execute();
      if (opts.soloSiFactura) return { lineas: 0, resumen: "", omitida: true };

      // Escaneo MANUAL de algo que no es factura: ya no hay modal obligatorio
      // al subir una imagen, así que esta es la única forma de describirla a
      // mano. Solo se guarda la PISTA que el usuario haya dado (texto real
      // escrito por él), nunca una copia de archivo.textoExtraido — ese texto
      // ya está disponible por su cuenta (combinarContenido lo muestra como
      // "Texto detectado (OCR)"); copiarlo aquí también dejaba la descripción
      // manual idéntica al OCR sin que el usuario hubiera escrito nada, y se
      // mostraba mal etiquetada como "Descripción:" en vez de "Texto detectado
      // (OCR)" la próxima vez que se abriera el archivo.
      const piezas = [opts.pista?.trim()].filter((p): p is string => !!p);
      const nuevas = piezas.filter((p) => !archivo.descripcionManual?.includes(p));
      if (nuevas.length > 0) {
        const nuevaDescripcion = [archivo.descripcionManual?.trim(), ...nuevas]
          .filter(Boolean)
          .join("\n\n");
        await actualizarDescripcionManual(archivo.id, nuevaDescripcion, usuarioId);
      }

      throw new AppError(
        422,
        opts.pista?.trim()
          ? "No he encontrado datos reales de una factura en este archivo (ni importes ni número/fecha/emisor). He guardado lo que indicaste como descripción del archivo."
          : "No he encontrado datos reales de una factura en este archivo (ni importes ni número/fecha/emisor). Si es una imagen difícil de leer, indica qué contiene en la pista — se guardará como descripción.",
      );
    }

    // Ya confirmado que es una factura: rellena los importes que el modelo dejó
    // a 0 a partir de la aritmética (líneas/subtotal/iva/total). Va DESPUÉS de la
    // guarda de arriba para no fabricar importes que la conviertan en "factura"
    // de la nada — solo mejora una que ya lo es.
    conciliarImportes(datos);

    // Clasifica la factura como venta/compra anclando en la empresa del propietario
    // (ver resolverDireccion). El aprendizaje del CIF de la empresa va aparte, por
    // corroboración, DESPUÉS de guardar (intentarAprenderCifEmpresa).
    const empresa = archivo.propietario.empresa ?? null;
    const direccion = resolverDireccion(datos, empresa, contenido);

    const facturaRepo = AppDataSource.getRepository(Factura);
    // Si ya se había escaneado este archivo, reemplazamos su factura (y sus líneas por CASCADE).
    await facturaRepo
      .createQueryBuilder()
      .delete()
      .where(`"archivoId" = :a AND "propietarioId" = :u`, { a: archivo.id, u: usuarioId })
      .execute();

    const factura = facturaRepo.create({
      propietario: { id: usuarioId } as Usuario,
      archivo: { id: archivo.id } as Archivo,
      numero: datos.numero,
      fecha: normalizarFecha(datos.fecha),
      emisor: datos.emisor,
      emisorNif: datos.emisorNif ?? null,
      cliente: datos.cliente,
      clienteNif: datos.clienteNif ?? null,
      tipo: direccion,
      moneda: normalizarMoneda(datos.moneda),
      subtotal: String(datos.subtotal ?? 0),
      iva: String(datos.iva ?? 0),
      total: String(datos.total ?? 0),
      lineas: (datos.lineas ?? []).map(
        (l) =>
          ({
            descripcion: l.descripcion,
            cantidad: String(l.cantidad ?? 0),
            precioUnit: String(l.precioUnit ?? 0),
            total: String(l.total ?? 0),
          }) as LineaFactura,
      ),
    });
    const guardada = await facturaRepo.save(factura); // cascade guarda las líneas
    await archivoRepo.update(archivo.id, { estadoEscaneo: "escaneada" });

    // Aprende el CIF de la empresa por corroboración (≥2 facturas con el mismo NIF
    // del lado del tenant). Best-effort: un fallo aquí no rompe el escaneo.
    if (empresa && !empresa.nif) {
      await intentarAprenderCifEmpresa(empresa.id).catch((err) =>
        console.error("[facturas] no se pudo aprender el CIF de la empresa (no crítico):", err),
      );
    }

    // Nada que escribir aquí: los resúmenes (individual y agregados) se generan
    // al vuelo desde la BD cuando el chat los pide (ver generarResumen*Md). La
    // factura ya está guardada, que es lo único que importa persistir.
    return {
      numero: datos.numero,
      total: datos.total,
      lineas: datos.lineas?.length ?? 0,
      resumen: resumenFacturaMd(datos),
    };
  } catch (err) {
    // Los 422 ("no parece factura", venga de aquí o del chequeo de importes
    // de más arriba que ya pone su propio "no_factura") son un resultado
    // esperado, no un fallo técnico — sin esto, "sin contenido legible" dejaba
    // el estado en "escaneando" para siempre (nunca pasaba a "no_factura").
    // Cualquier otra cosa sí es un fallo técnico real (Ollama caído, MinIO...).
    if (err instanceof AppError && err.statusCode === 422) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "no_factura" }).catch(() => {});
    } else if (!(err instanceof AppError)) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "error" }).catch(() => {});
    }
    throw err;
  }
};

// ¿El archivo es candidato a factura (PDF o imagen)?
export const esArchivoFactura = (archivo: Archivo): boolean =>
  /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(archivo.nombre) ||
  /^(application\/pdf|image\/)/.test(archivo.mimeType);

// Marca el archivo recién subido como "pendiente", para que la columna
// "Estado" del explorador muestre la animación desde el instante de la subida
// (antes de que el pipeline en segundo plano lo recoja). Se aplica a CUALQUIER
// archivo, no solo a los candidatos a factura: el indexado RAG (extracción de
// texto + embeddings) corre para todos, y el usuario debe ver que algo está
// pasando aunque luego no termine en ✓/✕ (ej. un .txt o una foto sin factura).
export const marcarPendiente = async (archivo: Archivo): Promise<void> => {
  archivo.estadoEscaneo = "pendiente";
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: "pendiente" });
};

// Marca el archivo como "en proceso" al arrancar el pipeline en segundo plano
// (indexado + auto-escaneo), también para cualquier archivo — así el spinner
// cubre el indexado RAG entero, no solo el escaneo de factura en sí.
export const marcarEnProceso = async (archivo: Archivo): Promise<void> => {
  archivo.estadoEscaneo = "escaneando";
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: "escaneando" });
};

// Al terminar el pipeline, si el archivo NO es candidato a factura no queda
// ningún estado final (escanearFactura ni se llega a invocar), así que el
// spinner se quedaría encendido para siempre si no lo limpiamos aquí.
export const limpiarEstadoSiNoEsFactura = async (archivo: Archivo): Promise<void> => {
  if (esArchivoFactura(archivo)) return;
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: null });
};

// Escaneo MANUAL disparado desde el explorador (clic derecho → Escanear). NO
// espera al resultado: en una GPU pequeña la extracción puede tardar minutos y
// bloquear el modal con "Escaneando…" toda la espera era el peor punto de
// fricción. Valida propiedad/existencia (para devolver 404/403 al instante),
// marca "pendiente" y encola en la fase de extracción (el texto ya se extrajo al
// subir; escanear NO relanza OCR). El estado final ("escaneada"/"no_factura"/
// "error") lo deja `escanearFactura` y la columna "Estado" lo refleja con su
// polling — igual que el auto-escaneo al subir.
export const encolarEscaneoManual = async (
  usuarioId: string,
  archivoId: string,
  pista?: string,
): Promise<void> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivo = await archivoRepo.findOne({
    where: { id: archivoId },
    relations: { propietario: true },
  });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso sobre este archivo");
  }
  await marcarPendiente(archivo);
  // El texto ya se extrajo al subir; escanear NO relanza OCR. Encolamos una
  // tarea durable de extracción (prioridad alta: la pide el usuario) que el
  // worker procesa. El estado final lo deja escanearFactura y lo refleja el
  // polling de la columna "Estado".
  await encolarTarea({
    tipo: "autoescanear",
    archivoId,
    usuarioId,
    prioridad: P_ALTA,
    pista,
  });
};

// Auto-escaneo al subir: si el archivo parece una factura, intenta escanearlo en
// segundo plano. Solo persiste si la extracción tiene pinta de factura (soloSiFactura).
// Pensado para llamarse "fire-and-forget"; los errores se logean, no se propagan.
export const autoEscanearArchivo = async (
  usuarioId: string,
  archivo: Archivo,
): Promise<void> => {
  if (!esArchivoFactura(archivo)) return;
  const r = await escanearFactura(usuarioId, archivo.id, { soloSiFactura: true });
  if (!r.omitida) {
    console.log(`[facturas] Auto-escaneada "${archivo.nombre}" (${r.lineas} línea/s)`);
  }
};

const resumenFacturaMd = (d: DatosFactura): string => {
  const m = d.moneda || "EUR";
  const lineas = (d.lineas ?? [])
    .map((l) => `| ${celdaMd(l.descripcion)} | ${unidadesMd(l.cantidad ?? 0)} | ${dinero(l.precioUnit ?? 0, m)} | ${dinero(l.total ?? 0, m)} |`)
    .join("\n");
  const titulo = d.archivoNombre || d.numero || "sin nombre";
  return `## Resumen ${titulo}

- **Fecha:** ${d.fecha ?? "—"}
- **Emisor:** ${celdaMd(d.emisor) || "—"}
- **Cliente:** ${celdaMd(d.cliente) || "—"}

| Artículo | Cantidad | Precio | Total |
|---|---|---|---|
${lineas}

- **Subtotal:** ${dinero(d.subtotal ?? 0, m)}
- **IVA:** ${dinero(d.iva ?? 0, m)}
- **TOTAL:** ${dinero(d.total ?? 0, m)}
`;
};

// Lee los datos de una factura YA ESCANEADA desde la BD (sin re-procesar el PDF).
export const obtenerFactura = async (
  usuarioId: string,
  archivoId: string,
  archivoNombre?: string,
): Promise<{ encontrada: boolean; resumen?: string; numero?: string }> => {
  const facturaRepo = AppDataSource.getRepository(Factura);
  const factura = await facturaRepo.findOne({
    where: { archivo: { id: archivoId }, propietario: { id: usuarioId } },
    relations: { lineas: true },
  });
  if (!factura) return { encontrada: false };

  const datos: DatosFactura = {
    numero: factura.numero,
    archivoNombre,
    fecha: factura.fecha ?? undefined,
    emisor: factura.emisor,
    cliente: factura.cliente,
    moneda: factura.moneda,
    subtotal: Number(factura.subtotal),
    iva: Number(factura.iva),
    total: Number(factura.total),
    lineas: factura.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnit: Number(l.precioUnit),
      total: Number(l.total),
    })),
  };
  return { encontrada: true, resumen: resumenFacturaMd(datos), numero: factura.numero };
};

// Filtro común para las consultas analíticas de facturas. Todos los campos son
// opcionales y se combinan en AND. `facturas` admite nº de factura o nombre de
// archivo (se busca en ambos). `producto` solo aplica a los rankings.
export type FiltroFacturas = {
  facturas?: string[];
  cliente?: string;
  emisor?: string;
  desde?: string;
  hasta?: string;
  producto?: string;
  // Ruta de carpeta YA normalizada (ej. "/facturas/2026"): incluye esa
  // carpeta y todo su subárbol. La resolución de nombre→ruta (con manejo de
  // ambigüedad) se hace en el caller (chat.service.ts, vía resolverCarpeta).
  carpeta?: string;
  // Código ISO 4217 de divisa (ej. "USD", "JPY") YA normalizado por el caller.
  // Filtra solo las facturas en esa moneda — útil para "facturas en dólares" o
  // "cuánto he facturado en yenes". Se compara contra f."moneda" (que se guarda
  // siempre normalizada a ISO en mayúsculas, ver normalizarMoneda).
  moneda?: string;
  // Dirección: "venta" (la empresa es el emisor), "compra" (es el cliente) o
  // "desconocido" (no clasificada). La analítica de ventas la fija a "venta" y la
  // de compras a "compra"; la página de Facturas la usa además con "desconocido"
  // para la pestaña "Sin clasificar". Sin este filtro, cuenta todas.
  tipo?: "venta" | "compra" | "desconocido";
}

// Construye las condiciones WHERE y los parámetros posicionales a partir del filtro.
// Asume que la consulta tiene alias "f" (facturas) y "a" (LEFT JOIN archivos).
// $1 es siempre el usuario.
const construirFiltro = (
  usuarioId: string,
  filtro: FiltroFacturas,
): { where: string; params: unknown[] } => {
  // Excluye facturas cuyo archivo está en la papelera: sin esto, una factura
  // borrada seguía contando en ventas_top/totales_facturas (el registro de
  // Factura en BD no depende del archivo para "existir" en estas consultas).
  // a."id" IS NULL cubre el caso (raro) de una factura sin archivo asociado.
  const cond: string[] = [`f."propietarioId" = $1`, `(a."id" IS NULL OR a."eliminadoEn" IS NULL)`];
  const params: unknown[] = [usuarioId];
  const add = (valor: unknown): string => {
    params.push(valor);
    return `$${params.length}`;
  };

  if (filtro.facturas?.length) {
    // Cada identificador puede coincidir con el nº de factura o el nombre de archivo.
    // Regex con límites de dígito (~*) para que "1" case con "factura_1.pdf" pero
    // NO con "factura_10.pdf"/"factura_21.pdf" (ILIKE %1% era demasiado amplio).
    const ors = filtro.facturas
      .map((id) => String(id).trim())
      .filter(Boolean)
      .map((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const p = add(`(^|[^0-9])${escaped}([^0-9]|$)`);
        return `(f."numero" ~* ${p} OR a."nombre" ~* ${p})`;
      });
    if (ors.length) cond.push(`(${ors.join(" OR ")})`);
  }
  // unaccent() en ambos lados: para que "Tecnologias" (sin tilde, lo más común
  // al escribir rápido) encuentre "Tecnologías".
  if (filtro.cliente?.trim())
    cond.push(`unaccent(f."cliente") ILIKE unaccent(${add(`%${filtro.cliente.trim()}%`)})`);
  if (filtro.emisor?.trim())
    cond.push(`unaccent(f."emisor") ILIKE unaccent(${add(`%${filtro.emisor.trim()}%`)})`);
  if (filtro.desde) cond.push(`f."fecha" >= ${add(filtro.desde)}::date`);
  if (filtro.hasta) cond.push(`f."fecha" <= ${add(filtro.hasta)}::date`);
  if (filtro.producto?.trim())
    cond.push(`unaccent(l."descripcion") ILIKE unaccent(${add(`%${filtro.producto.trim()}%`)})`);
  if (filtro.carpeta) {
    const r = filtro.carpeta;
    cond.push(`(a."carpeta" = ${add(r)} OR a."carpeta" LIKE ${add(`${r}/%`)})`);
  }
  // Igualdad exacta: la moneda se guarda siempre normalizada a ISO en mayúsculas,
  // y el caller normaliza la que pide el usuario de la misma forma.
  if (filtro.moneda?.trim())
    cond.push(`f."moneda" = ${add(filtro.moneda.trim().toUpperCase())}`);
  if (filtro.tipo) cond.push(`f."tipo" = ${add(filtro.tipo)}`);

  return { where: cond.join(" AND "), params };
};

// Encabezado de sección de moneda; solo se muestra cuando hay más de una divisa
// (con una sola, la columna de importe ya lleva el símbolo y un subtítulo sobra).
const encabezadoMoneda = (m: string, varias: boolean): string =>
  varias ? `### ${nombreMoneda(m)} (${dinero(0, m).replace(/[\d.,\s-]/g, "").trim()})\n\n` : "";

// Markdown de un ranking de productos, AGRUPADO POR MONEDA (importes con su
// símbolo server-side). Una sección por divisa cuando hay varias.
export const rankingMd = (
  filas: { producto: string; moneda: string; unidades: number; importe: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay datos de ventas para esa consulta.";
  const monedas = monedasDistintas(filas);
  const varias = monedas.length > 1;
  const secciones = monedas.map((m) => {
    const cuerpo = filas
      .filter((t) => t.moneda === m)
      .map((t, i) => `| ${i + 1} | ${celdaMd(t.producto)} | ${unidadesMd(t.unidades)} | ${dinero(t.importe, m)} |`)
      .join("\n");
    return `${encabezadoMoneda(m, varias)}| # | Producto | Unidades | Importe |\n|---|---|---|---|\n${cuerpo}`;
  });
  return `## ${titulo}\n\n${secciones.join("\n\n")}`;
};

// Markdown de los totales facturados, AGRUPADO POR MONEDA. Una sección por divisa
// cuando hay varias (nunca se suman importes de divisas distintas).
export const totalesMd = (filas: TotalesMoneda[], titulo: string): string => {
  if (filas.length === 0) return "No hay facturas que cumplan esa consulta.";
  const varias = filas.length > 1;
  const secciones = filas.map(
    (t) =>
      `${encabezadoMoneda(t.moneda, varias)}- **Facturas:** ${unidadesMd(t.numFacturas)}\n- **Subtotal:** ${dinero(t.subtotal, t.moneda)}\n- **IVA:** ${dinero(t.iva, t.moneda)}\n- **TOTAL:** ${dinero(t.total, t.moneda)}`,
  );
  return `## ${titulo}\n\n${secciones.join("\n\n")}`;
};

// Markdown de un listado de facturas (importe con su moneda server-side). Se usa
// para "facturas de [mes/año]" cuando se pide el LISTADO, no el total agregado.
// Es el texto de respaldo para clientes sin UI (curl, etc.); el frontend renderiza
// estas mismas filas como una tabla con botón "Abrir" (ver `archivos` en chat.service.ts).
// Aquí NO se agrupa por moneda (es un listado cronológico): cada línea lleva su divisa.
export const listadoFacturasMd = (
  filas: { archivoId: string | null; archivoNombre: string | null; numero: string; fecha: string; total: number; moneda: string }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay facturas que cumplan esa consulta.";
  const cuerpo = filas
    .map((f) => `- **${f.archivoNombre ?? f.numero}** (${formatearFecha(f.fecha)}): ${dinero(f.total, f.moneda)}`)
    .join("\n");
  return `## ${titulo}\n\n${cuerpo}`;
};

// Ranking de productos (por importe) sobre las facturas que cumplen el filtro.
// orden 'desc' = más vendido (defecto); 'asc' = menos vendido.
export const ventasTop = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { orden?: "desc" | "asc"; limite?: number } = {},
): Promise<{ producto: string; moneda: string; unidades: number; importe: number }[]> => {
  // Por defecto solo ventas; el ranking de compras reusa esta función con tipo="compra".
  const { where, params } = construirFiltro(usuarioId, { ...filtro, tipo: filtro.tipo ?? "venta" });
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  // Ranking TOP-N POR MONEDA: no se puede sumar unidades de productos facturados
  // en divisas distintas en una misma tabla. ROW_NUMBER particionado por moneda
  // da las N primeras de cada divisa; el llamador (rankingMd) las agrupa en una
  // sección por moneda. `l."total" > 0` descarta las líneas de importe 0 (una
  // devolución/RMA sin cargo NO es una venta: no debe salir en "más vendidos").
  const filas: { producto: string; moneda: string; unidades: number; importe: number }[] =
    await AppDataSource.query(
      `SELECT t.producto, t.moneda, t.unidades, t.importe FROM (
         SELECT lower(l."descripcion") AS producto,
                f."moneda" AS moneda,
                SUM(l."cantidad")::float AS unidades,
                SUM(l."total")::float AS importe,
                ROW_NUMBER() OVER (PARTITION BY f."moneda" ORDER BY SUM(l."cantidad") ${orden}) AS rn
         FROM "lineas_factura" l
         JOIN "facturas" f ON f."id" = l."facturaId"
         LEFT JOIN "archivos" a ON a."id" = f."archivoId"
         WHERE ${where} AND l."total" > 0
         GROUP BY lower(l."descripcion"), f."moneda"
       ) t
       WHERE t.rn <= ${limiteParam}
       ORDER BY t.moneda, t.unidades ${orden}`,
      [...params, opts.limite ?? 10],
    );
  return filas.map((r) => ({
    producto: r.producto,
    moneda: r.moneda,
    unidades: Number(r.unidades),
    importe: Number(r.importe),
  }));
};

// Totales facturados (nº facturas, subtotal, IVA, total) sobre el filtro dado.
// El campo `producto` del filtro no aplica aquí (son totales de cabecera).
export type TotalesMoneda = {
  moneda: string;
  numFacturas: number;
  subtotal: number;
  iva: number;
  total: number;
};

// Totales facturados AGRUPADOS POR MONEDA (una fila por divisa), ordenados por
// total descendente. Sumar importes de divisas distintas no tiene sentido, así
// que cada moneda lleva su propio total/subtotal/IVA. Con una sola moneda (el
// caso normal) devuelve un único elemento.
export const totalesFacturado = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
): Promise<TotalesMoneda[]> => {
  const { producto: _producto, ...rest } = filtro;
  // Por defecto solo ventas; los totales de compras reusan esta función con tipo="compra".
  const { where, params } = construirFiltro(usuarioId, { ...rest, tipo: rest.tipo ?? "venta" });
  const filas = await AppDataSource.query(
    `SELECT f."moneda" AS moneda,
            COUNT(DISTINCT f."id")::int AS numfacturas,
            COALESCE(SUM(f."subtotal"), 0)::float AS subtotal,
            COALESCE(SUM(f."iva"), 0)::float AS iva,
            COALESCE(SUM(f."total"), 0)::float AS total
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${where}
     GROUP BY f."moneda"
     ORDER BY total DESC`,
    params,
  );
  return filas.map((row: Record<string, unknown>) => ({
    moneda: (row.moneda as string) || "EUR",
    numFacturas: Number(row.numfacturas),
    subtotal: Number(row.subtotal),
    iva: Number(row.iva),
    total: Number(row.total),
  }));
};

export type FilaFactura = {
  id: string;
  archivoId: string | null;
  archivoNombre: string | null;
  numero: string;
  fecha: string;
  emisor: string;
  cliente: string;
  tipo: "venta" | "compra" | "desconocido";
  subtotal: number;
  iva: number;
  total: number;
  moneda: string;
};

// Lista (no agrega) las facturas que cumplen el filtro, con el archivo asociado
// para poder ofrecer un botón "Abrir" por cada una. El filtro `producto` SÍ
// aplica aquí (para "facturas donde he vendido X" / "facturas con X"): se resuelve
// con un EXISTS sobre lineas_factura, en vez de un JOIN, para no duplicar filas ni
// alterar la semántica del ranking (ventasTop, que sí usa el JOIN con alias `l`).
// Paginado (pagina 1-indexada): con muchas facturas, devolver todas de golpe
// en el chat sería una tabla enorme — el cuadro HTML del chat pagina pidiendo
// página a página a esta misma función vía un endpoint dedicado (ver
// ctrlListarFacturas).
export const listarFacturas = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { pagina?: number; limite?: number } = {},
): Promise<{ filas: FilaFactura[]; total: number; paginas: number }> => {
  const pagina = Math.max(1, opts.pagina ?? 1);
  const limite = Math.min(Math.max(1, opts.limite ?? 20), 100);
  const { producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, rest);
  let filtroWhere = where;
  if (producto?.trim()) {
    params.push(`%${producto.trim()}%`);
    filtroWhere += ` AND EXISTS (SELECT 1 FROM "lineas_factura" l WHERE l."facturaId" = f."id" AND unaccent(l."descripcion") ILIKE unaccent($${params.length}))`;
  }
  const [{ total }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS total FROM "facturas" f LEFT JOIN "archivos" a ON a."id" = f."archivoId" WHERE ${filtroWhere}`,
    params,
  );
  const filas: FilaRaw[] = await AppDataSource.query(
    `SELECT f."id" AS id, a."id" AS archivoid, a."nombre" AS archivonombre, f."numero" AS numero,
            f."fecha"::text AS fecha, f."emisor" AS emisor, f."cliente" AS cliente, f."tipo" AS tipo,
            f."subtotal" AS subtotal, f."iva" AS iva, f."total" AS total, f."moneda" AS moneda
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${filtroWhere}
     ORDER BY f."fecha" DESC NULLS LAST, f."creadoEn" DESC
     LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
    params,
  );
  return {
    filas: filas.map(aFilaFactura),
    total: Number(total),
    paginas: Math.max(1, Math.ceil(Number(total) / limite)),
  };
};

// Fila cruda de las consultas de listado y su mapeo a FilaFactura (compartido por
// listarFacturas y listarFacturasPapelera).
type FilaRaw = {
  id: string;
  archivoid: string | null;
  archivonombre: string | null;
  numero: string | null;
  fecha: string | null;
  emisor: string | null;
  cliente: string | null;
  tipo: "venta" | "compra" | "desconocido";
  subtotal: string;
  iva: string;
  total: string;
  moneda: string;
};
const aFilaFactura = (r: FilaRaw): FilaFactura => ({
  id: r.id,
  archivoId: r.archivoid,
  archivoNombre: r.archivonombre,
  numero: r.numero ?? "",
  fecha: r.fecha ?? "",
  emisor: r.emisor ?? "",
  cliente: r.cliente ?? "",
  tipo: r.tipo,
  subtotal: Number(r.subtotal),
  iva: Number(r.iva),
  total: Number(r.total),
  moneda: r.moneda || "EUR",
});

// Lista las facturas cuyo archivo está en la papelera (soft-deleted) — lo
// inverso de listarFacturas/construirFiltro, que las excluyen siempre. Para
// "facturas de la papelera" en el chat, antes de restaurarlas o vaciar.
export const listarFacturasPapelera = async (
  usuarioId: string,
  opts: { pagina?: number; limite?: number } = {},
): Promise<{ filas: FilaFactura[]; total: number; paginas: number }> => {
  const pagina = Math.max(1, opts.pagina ?? 1);
  const limite = Math.min(Math.max(1, opts.limite ?? 20), 100);
  const [{ total }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS total FROM "facturas" f JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE f."propietarioId" = $1 AND a."eliminadoEn" IS NOT NULL`,
    [usuarioId],
  );
  const filas: FilaRaw[] = await AppDataSource.query(
    `SELECT f."id" AS id, a."id" AS archivoid, a."nombre" AS archivonombre, f."numero" AS numero,
            f."fecha"::text AS fecha, f."emisor" AS emisor, f."cliente" AS cliente, f."tipo" AS tipo,
            f."subtotal" AS subtotal, f."iva" AS iva, f."total" AS total, f."moneda" AS moneda
     FROM "facturas" f
     JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE f."propietarioId" = $1 AND a."eliminadoEn" IS NOT NULL
     ORDER BY a."eliminadoEn" DESC
     LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
    [usuarioId],
  );
  return {
    filas: filas.map(aFilaFactura),
    total: Number(total),
    paginas: Math.max(1, Math.ceil(Number(total) / limite)),
  };
};

// --- Detalle y edición manual de una factura (página "Facturas") ---
// El modelo pequeño siempre falla algún campo; la edición manual es la red de
// seguridad para corregir emisor/cliente/tipo/importes/líneas. Al guardar se
// regeneran el resumen individual y los agregados (ventas/compras).
export type LineaDetalle = { descripcion: string; cantidad: number; precioUnit: number; total: number };
export type FacturaDetalle = {
  id: string;
  archivoId: string | null;
  archivoNombre: string | null;
  numero: string;
  fecha: string | null;
  emisor: string;
  emisorNif: string;
  cliente: string;
  clienteNif: string;
  tipo: "venta" | "compra" | "desconocido";
  moneda: string;
  subtotal: number;
  iva: number;
  total: number;
  lineas: LineaDetalle[];
};

export const obtenerFacturaDetalle = async (
  usuarioId: string,
  facturaId: string,
): Promise<FacturaDetalle> => {
  const f = await AppDataSource.getRepository(Factura).findOne({
    where: { id: facturaId, propietario: { id: usuarioId } },
    relations: { lineas: true, archivo: true },
  });
  if (!f) throw new AppError(404, "Factura no encontrada");
  return {
    id: f.id,
    archivoId: f.archivo?.id ?? null,
    archivoNombre: f.archivo?.nombre ?? null,
    numero: f.numero ?? "",
    fecha: f.fecha ?? null,
    emisor: f.emisor ?? "",
    emisorNif: f.emisorNif ?? "",
    cliente: f.cliente ?? "",
    clienteNif: f.clienteNif ?? "",
    tipo: f.tipo,
    moneda: f.moneda,
    subtotal: Number(f.subtotal),
    iva: Number(f.iva),
    total: Number(f.total),
    lineas: (f.lineas ?? []).map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnit: Number(l.precioUnit),
      total: Number(l.total),
    })),
  };
};

export const schemaActualizarFactura = z.object({
  numero: z.string().trim().optional(),
  fecha: z.string().trim().nullable().optional(),
  emisor: z.string().trim().optional(),
  emisorNif: z.string().trim().optional(),
  cliente: z.string().trim().optional(),
  clienteNif: z.string().trim().optional(),
  tipo: z.enum(["venta", "compra", "desconocido"]).optional(),
  moneda: z.string().trim().optional(),
  subtotal: z.number().optional(),
  iva: z.number().optional(),
  total: z.number().optional(),
  lineas: z
    .array(
      z.object({
        descripcion: z.string(),
        cantidad: z.number().optional(),
        precioUnit: z.number().optional(),
        total: z.number().optional(),
      }),
    )
    .optional(),
});

export const actualizarFactura = async (
  usuarioId: string,
  facturaId: string,
  datos: z.infer<typeof schemaActualizarFactura>,
): Promise<FacturaDetalle> => {
  const facturaRepo = AppDataSource.getRepository(Factura);
  const factura = await facturaRepo.findOne({
    where: { id: facturaId, propietario: { id: usuarioId } },
    relations: { archivo: true },
  });
  if (!factura) throw new AppError(404, "Factura no encontrada");

  const patch: Partial<Factura> = {};
  if (datos.numero !== undefined) patch.numero = datos.numero;
  if (datos.fecha !== undefined) patch.fecha = datos.fecha ? normalizarFecha(datos.fecha) : null;
  if (datos.emisor !== undefined) patch.emisor = datos.emisor;
  if (datos.emisorNif !== undefined) patch.emisorNif = datos.emisorNif || null;
  if (datos.cliente !== undefined) patch.cliente = datos.cliente;
  if (datos.clienteNif !== undefined) patch.clienteNif = datos.clienteNif || null;
  if (datos.tipo !== undefined) patch.tipo = datos.tipo;
  if (datos.moneda !== undefined) patch.moneda = normalizarMoneda(datos.moneda);
  if (datos.subtotal !== undefined) patch.subtotal = String(datos.subtotal);
  if (datos.iva !== undefined) patch.iva = String(datos.iva);
  if (datos.total !== undefined) patch.total = String(datos.total);
  if (Object.keys(patch).length) await facturaRepo.update(facturaId, patch);

  // Líneas: se reemplazan enteras (borrar + insertar) para no arrastrar huérfanas.
  if (datos.lineas !== undefined) {
    const lineaRepo = AppDataSource.getRepository(LineaFactura);
    await lineaRepo.delete({ factura: { id: facturaId } });
    if (datos.lineas.length) {
      await lineaRepo.insert(
        datos.lineas.map((l) => ({
          descripcion: l.descripcion,
          cantidad: String(l.cantidad ?? 0),
          precioUnit: String(l.precioUnit ?? 0),
          total: String(l.total ?? 0),
          factura: { id: facturaId } as Factura,
        })),
      );
    }
  }

  // Nada que regenerar: los resúmenes (individual y agregados) se generan al
  // vuelo desde la BD, así que la corrección ya queda reflejada en cuanto se
  // guardan los cambios de arriba.

  return obtenerFacturaDetalle(usuarioId, facturaId);
};

// Re-aplica la clasificación venta/compra a TODAS las facturas del usuario usando
// los datos ya guardados (emisor/cliente/NIFs + el texto del archivo para el ancla
// CIF-en-texto), SIN re-escanear ni re-OCR. Para cuando se fija/corrige el CIF de la
// empresa después de haber escaneado (típico: la empresa estaba sin CIF y todo salió
// "desconocido"). Aprende el CIF por corroboración si aún no lo tiene y regenera los
// resúmenes. Devuelve cuántas cambiaron de tipo.
export const reclasificarFacturas = async (
  usuarioId: string,
): Promise<{ actualizadas: number; total: number }> => {
  const usuario = await AppDataSource.getRepository(Usuario).findOne({
    where: { id: usuarioId },
    relations: { empresa: true },
  });
  const empresa = usuario?.empresa ?? null;
  const facturaRepo = AppDataSource.getRepository(Factura);
  const facturas = await facturaRepo.find({
    where: { propietario: { id: usuarioId } },
    relations: { archivo: true },
  });
  let actualizadas = 0;
  for (const f of facturas) {
    const datos: DatosFactura = {
      emisor: f.emisor,
      emisorNif: f.emisorNif ?? undefined,
      cliente: f.cliente,
      clienteNif: f.clienteNif ?? undefined,
    };
    const nuevo = resolverDireccion(datos, empresa, f.archivo?.textoExtraido ?? "");
    if (nuevo !== f.tipo) {
      await facturaRepo.update(f.id, { tipo: nuevo });
      actualizadas++;
    }
  }
  if (empresa && !empresa.nif) {
    await intentarAprenderCifEmpresa(empresa.id).catch(() => {});
  }
  // Los resúmenes se generan al vuelo desde la BD: la reclasificación ya queda
  // reflejada sin necesidad de regenerar ningún .md.
  return { actualizadas, total: facturas.length };
};

// Ranking de clientes por gasto total. orden 'desc' = quién más gastó (defecto);
// 'asc' = quién menos. El campo `producto` del filtro no aplica aquí (no hay
// JOIN con lineas_factura, igual que en totalesFacturado).
export const clientesTop = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { orden?: "desc" | "asc"; limite?: number } = {},
): Promise<{ cliente: string; moneda: string; numFacturas: number; importe: number }[]> => {
  const { producto: _producto, ...rest } = filtro;
  // El ranking de clientes es solo de ventas (el gasto en compras se rankea por
  // proveedor/emisor, ver proveedoresTop).
  const { where, params } = construirFiltro(usuarioId, { ...rest, tipo: rest.tipo ?? "venta" });
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  // TOP-N POR MONEDA: el gasto de un cliente en € y en $ son cifras distintas
  // que no se suman. ROW_NUMBER particionado por moneda da las N de cada divisa.
  // `HAVING SUM(total) > 0` excluye del ranking a un cliente cuyo gasto total es
  // 0 (solo facturas de devolución sin cargo): no es "quién más/menos gastó".
  const filas: { cliente: string; moneda: string; numfacturas: string; importe: string }[] =
    await AppDataSource.query(
      `SELECT t.cliente, t.moneda, t.numfacturas, t.importe FROM (
         SELECT f."cliente" AS cliente,
                f."moneda" AS moneda,
                COUNT(*)::int AS numfacturas,
                SUM(f."total")::float AS importe,
                ROW_NUMBER() OVER (PARTITION BY f."moneda" ORDER BY SUM(f."total") ${orden}) AS rn
         FROM "facturas" f
         LEFT JOIN "archivos" a ON a."id" = f."archivoId"
         WHERE ${where} AND f."cliente" IS NOT NULL AND f."cliente" <> ''
         GROUP BY f."cliente", f."moneda"
         HAVING SUM(f."total") > 0
       ) t
       WHERE t.rn <= ${limiteParam}
       ORDER BY t.moneda, t.importe ${orden}`,
      [...params, opts.limite ?? 10],
    );
  return filas.map((r) => ({
    cliente: r.cliente,
    moneda: r.moneda,
    numFacturas: Number(r.numfacturas),
    importe: Number(r.importe),
  }));
};

// Markdown de un ranking de clientes por gasto total, AGRUPADO POR MONEDA
// (importes con su símbolo server-side). Una sección por divisa cuando hay varias.
export const clientesTopMd = (
  filas: { cliente: string; moneda: string; numFacturas: number; importe: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay datos de clientes para esa consulta.";
  const monedas = monedasDistintas(filas);
  const varias = monedas.length > 1;
  const secciones = monedas.map((m) => {
    const cuerpo = filas
      .filter((c) => c.moneda === m)
      .map((c, i) => `| ${i + 1} | ${celdaMd(c.cliente)} | ${unidadesMd(c.numFacturas)} | ${dinero(c.importe, m)} |`)
      .join("\n");
    return `${encabezadoMoneda(m, varias)}| # | Cliente | Facturas | Importe |\n|---|---|---|---|\n${cuerpo}`;
  });
  return `## ${titulo}\n\n${secciones.join("\n\n")}`;
};

// Ranking de PROVEEDORES por gasto total (facturas de COMPRA), espejo de
// clientesTop pero agrupando por f."emisor" (el proveedor que nos factura). orden
// 'desc' = a quién más le compramos (defecto); 'asc' = a quién menos.
export const proveedoresTop = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { orden?: "desc" | "asc"; limite?: number } = {},
): Promise<{ proveedor: string; moneda: string; numFacturas: number; importe: number }[]> => {
  const { producto: _producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, { ...rest, tipo: "compra" });
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  const filas: { proveedor: string; moneda: string; numfacturas: string; importe: string }[] =
    await AppDataSource.query(
      `SELECT t.proveedor, t.moneda, t.numfacturas, t.importe FROM (
         SELECT f."emisor" AS proveedor,
                f."moneda" AS moneda,
                COUNT(*)::int AS numfacturas,
                SUM(f."total")::float AS importe,
                ROW_NUMBER() OVER (PARTITION BY f."moneda" ORDER BY SUM(f."total") ${orden}) AS rn
         FROM "facturas" f
         LEFT JOIN "archivos" a ON a."id" = f."archivoId"
         WHERE ${where} AND f."emisor" IS NOT NULL AND f."emisor" <> ''
         GROUP BY f."emisor", f."moneda"
         HAVING SUM(f."total") > 0
       ) t
       WHERE t.rn <= ${limiteParam}
       ORDER BY t.moneda, t.importe ${orden}`,
      [...params, opts.limite ?? 10],
    );
  return filas.map((r) => ({
    proveedor: r.proveedor,
    moneda: r.moneda,
    numFacturas: Number(r.numfacturas),
    importe: Number(r.importe),
  }));
};

// Markdown de un ranking de proveedores por gasto total, AGRUPADO POR MONEDA.
export const proveedoresTopMd = (
  filas: { proveedor: string; moneda: string; numFacturas: number; importe: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay datos de proveedores para esa consulta.";
  const monedas = monedasDistintas(filas);
  const varias = monedas.length > 1;
  const secciones = monedas.map((m) => {
    const cuerpo = filas
      .filter((c) => c.moneda === m)
      .map((c, i) => `| ${i + 1} | ${celdaMd(c.proveedor)} | ${unidadesMd(c.numFacturas)} | ${dinero(c.importe, m)} |`)
      .join("\n");
    return `${encabezadoMoneda(m, varias)}| # | Proveedor | Facturas | Importe |\n|---|---|---|---|\n${cuerpo}`;
  });
  return `## ${titulo}\n\n${secciones.join("\n\n")}`;
};

// Dado un conjunto de identificadores (nº/nombre de archivo), localiza los ficheros
// de factura que casan y PONE A ESCANEAR en segundo plano los que aún no lo
// estén (vía encolarEscaneoManual: no espera al OCR/IA, que puede tardar
// minutos y colgaría la petición del chat — ver bugs.txt "escanea todas las
// facturas... 504"). Devuelve cuántas quedaron encoladas: el llamador debe
// avisar de que esas aún no entran en el resultado y reintentar más tarde.
export const asegurarFacturasEscaneadas = async (
  usuarioId: string,
  identificadores: string[],
): Promise<number> => {
  const ids = identificadores.map((s) => String(s).trim()).filter(Boolean);
  if (ids.length === 0) return 0;

  const archivoRepo = AppDataSource.getRepository(Archivo);
  const qb = archivoRepo
    .createQueryBuilder("a")
    .where("a.propietarioId = :uid", { uid: usuarioId })
    .andWhere("a.eliminadoEn IS NULL");
  // Mismo matching con límites de dígito que el filtro de analítica.
  const ors = ids.map((_, i) => `a."nombre" ~* :re${i}`);
  qb.andWhere(`(${ors.join(" OR ")})`);
  ids.forEach((id, i) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    qb.setParameter(`re${i}`, `(^|[^0-9])${escaped}([^0-9]|$)`);
  });
  const archivos = await qb.getMany();

  // Solo ficheros que parezcan factura (PDF/imagen).
  const facturasArchivo = archivos.filter(
    (a) =>
      /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(a.nombre) ||
      /^(application\/pdf|image\/)/.test(a.mimeType),
  );
  if (facturasArchivo.length === 0) return 0;

  const facturaRepo = AppDataSource.getRepository(Factura);
  let encoladas = 0;
  for (const archivo of facturasArchivo) {
    if (archivo.estadoEscaneo === "pendiente" || archivo.estadoEscaneo === "escaneando") continue;
    const ya = await facturaRepo.findOne({
      where: { archivo: { id: archivo.id }, propietario: { id: usuarioId } },
    });
    if (ya) continue; // ya estaba escaneada
    await encolarEscaneoManual(usuarioId, archivo.id);
    encoladas++;
  }
  return encoladas;
};

// Totales globales de ventas + top productos/clientes. Usa el mismo
// `construirFiltro` (sin filtro real, solo el usuario) que ventasTop/
// totalesFacturado, así que excluye igual las facturas cuyo archivo está en
// la papelera — antes este conteo iba por su cuenta con un COUNT(*) directo
// sobre "facturas" sin ese JOIN/exclusión, así que una factura borrada (o
// restaurada) no movía nunca este número.
export type ResumenMoneda = {
  moneda: string;
  numFacturas: number;
  subtotal: number;
  iva: number;
  total: number;
  ticketMedio: number;
  top: { producto: string; moneda: string; unidades: number; importe: number }[];
  clientes: { cliente: string; moneda: string; numFacturas: number; importe: number }[];
};

export const resumenVentas = async (
  usuarioId: string,
): Promise<{
  numFacturas: number; // total de facturas (todas las monedas), para la cabecera general
  primeraFecha: string | null;
  ultimaFecha: string | null;
  porMoneda: ResumenMoneda[];
}> => {
  const { where, params } = construirFiltro(usuarioId, { tipo: "venta" });
  // Cabecera general: conteo y periodo son independientes de la divisa (no se
  // suman importes aquí, solo se cuentan facturas y se mira el rango de fechas).
  const [row] = await AppDataSource.query(
    `SELECT COUNT(DISTINCT f."id")::int AS numfacturas,
            MIN(f."fecha")::text AS primera,
            MAX(f."fecha")::text AS ultima
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${where}`,
    params,
  );
  const [totales, top, clientes] = await Promise.all([
    totalesFacturado(usuarioId, {}),
    ventasTop(usuarioId, {}, { limite: 5 }),
    clientesTop(usuarioId, {}, { limite: 3 }),
  ]);
  const porMoneda: ResumenMoneda[] = totales.map((t) => ({
    moneda: t.moneda,
    numFacturas: t.numFacturas,
    subtotal: t.subtotal,
    iva: t.iva,
    total: t.total,
    ticketMedio: t.numFacturas > 0 ? t.total / t.numFacturas : 0,
    top: top.filter((p) => p.moneda === t.moneda),
    clientes: clientes.filter((c) => c.moneda === t.moneda),
  }));
  return {
    numFacturas: Number(row.numfacturas),
    primeraFecha: row.primera ?? null,
    ultimaFecha: row.ultima ?? null,
    porMoneda,
  };
};

// Genera el markdown del resumen AGREGADO de ventas leyendo la BD al vuelo.
// Devuelve null si el usuario no tiene ninguna venta (el chat responde con su
// propio mensaje de "todavía no hay resumen"). Antes esto se materializaba como
// un archivo "resumen-ventas.md" en /facturas; ahora es datos derivados que se
// calculan solo cuando el chat los pide.
export const generarResumenVentasMd = async (usuarioId: string): Promise<string | null> => {
  const { numFacturas, primeraFecha, ultimaFecha, porMoneda } = await resumenVentas(usuarioId);

  if (numFacturas === 0) return null;

  const periodo =
    primeraFecha && ultimaFecha
      ? `${formatearFecha(primeraFecha)} – ${formatearFecha(ultimaFecha)}`
      : "—";
  const varias = porMoneda.length > 1;

  // Una sección por moneda: totales + más vendidos + mejores clientes de esa
  // divisa. Con una sola moneda (caso normal) el encabezado de divisa se omite y
  // el resultado se lee igual que el resumen de antes, pero con el símbolo correcto.
  const secciones = porMoneda
    .map((m) => {
      const ranking = m.top
        .map((t, i) => `${i + 1}. **${t.producto}** — ${unidadesMd(t.unidades)} ud. — ${dinero(t.importe, m.moneda)}`)
        .join("\n");
      const rankingClientes = m.clientes
        .map((c, i) => `${i + 1}. **${c.cliente}** — ${unidadesMd(c.numFacturas)} factura/s — ${dinero(c.importe, m.moneda)}`)
        .join("\n");
      const cab = varias ? `## ${nombreMoneda(m.moneda)} (${dinero(0, m.moneda).replace(/[\d.,\s-]/g, "").trim()})\n\n` : "";
      return `${cab}- **Facturas:** ${unidadesMd(m.numFacturas)}
- **Total facturado:** ${dinero(m.total, m.moneda)}
- **Subtotal:** ${dinero(m.subtotal, m.moneda)}
- **IVA:** ${dinero(m.iva, m.moneda)}
- **Ticket medio:** ${dinero(m.ticketMedio, m.moneda)}

${varias ? "### Más vendidos" : "## Más vendidos"}
${ranking || "_(todavía no hay datos)_"}

${varias ? "### Mejores clientes" : "## Mejores clientes"}
${rankingClientes || "_(todavía no hay datos)_"}`;
    })
    .join("\n\n");

  // Cabecera general (independiente de la divisa) + el desglose por moneda.
  const cabeceraGeneral = `- **Facturas escaneadas:** ${unidadesMd(numFacturas)}
- **Periodo:** ${periodo}${varias ? `\n- **Monedas:** ${porMoneda.map((m) => m.moneda).join(", ")}` : ""}`;

  return `# Resumen de ventas

${cabeceraGeneral}

${secciones}
`;
};

// --- Resumen de COMPRAS (facturas donde la empresa es el cliente) ---
// Espejo de resumenVentas pero con tipo="compra" y ranking por PROVEEDOR (emisor)
// en vez de por cliente.
type ResumenComprasMoneda = {
  moneda: string;
  numFacturas: number;
  subtotal: number;
  iva: number;
  total: number;
  ticketMedio: number;
  top: { producto: string; moneda: string; unidades: number; importe: number }[];
  proveedores: { proveedor: string; moneda: string; numFacturas: number; importe: number }[];
};

const resumenCompras = async (
  usuarioId: string,
): Promise<{
  numFacturas: number;
  primeraFecha: string | null;
  ultimaFecha: string | null;
  porMoneda: ResumenComprasMoneda[];
}> => {
  const { where, params } = construirFiltro(usuarioId, { tipo: "compra" });
  const [row] = await AppDataSource.query(
    `SELECT COUNT(DISTINCT f."id")::int AS numfacturas,
            MIN(f."fecha")::text AS primera,
            MAX(f."fecha")::text AS ultima
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${where}`,
    params,
  );
  const [totales, top, proveedores] = await Promise.all([
    totalesFacturado(usuarioId, { tipo: "compra" }),
    ventasTop(usuarioId, { tipo: "compra" }, { limite: 5 }),
    proveedoresTop(usuarioId, {}, { limite: 3 }),
  ]);
  const porMoneda: ResumenComprasMoneda[] = totales.map((t) => ({
    moneda: t.moneda,
    numFacturas: t.numFacturas,
    subtotal: t.subtotal,
    iva: t.iva,
    total: t.total,
    ticketMedio: t.numFacturas > 0 ? t.total / t.numFacturas : 0,
    top: top.filter((p) => p.moneda === t.moneda),
    proveedores: proveedores.filter((p) => p.moneda === t.moneda),
  }));
  return {
    numFacturas: Number(row.numfacturas),
    primeraFecha: row.primera ?? null,
    ultimaFecha: row.ultima ?? null,
    porMoneda,
  };
};

// Espejo de generarResumenVentasMd para las COMPRAS. null si no hay compras.
export const generarResumenComprasMd = async (usuarioId: string): Promise<string | null> => {
  const { numFacturas, primeraFecha, ultimaFecha, porMoneda } = await resumenCompras(usuarioId);

  if (numFacturas === 0) return null;

  const periodo =
    primeraFecha && ultimaFecha
      ? `${formatearFecha(primeraFecha)} – ${formatearFecha(ultimaFecha)}`
      : "—";
  const varias = porMoneda.length > 1;

  const secciones = porMoneda
    .map((m) => {
      const ranking = m.top
        .map((t, i) => `${i + 1}. **${t.producto}** — ${unidadesMd(t.unidades)} ud. — ${dinero(t.importe, m.moneda)}`)
        .join("\n");
      const rankingProveedores = m.proveedores
        .map((p, i) => `${i + 1}. **${p.proveedor}** — ${unidadesMd(p.numFacturas)} factura/s — ${dinero(p.importe, m.moneda)}`)
        .join("\n");
      const cab = varias ? `## ${nombreMoneda(m.moneda)} (${dinero(0, m.moneda).replace(/[\d.,\s-]/g, "").trim()})\n\n` : "";
      return `${cab}- **Facturas:** ${unidadesMd(m.numFacturas)}
- **Total gastado:** ${dinero(m.total, m.moneda)}
- **Subtotal:** ${dinero(m.subtotal, m.moneda)}
- **IVA:** ${dinero(m.iva, m.moneda)}
- **Gasto medio:** ${dinero(m.ticketMedio, m.moneda)}

${varias ? "### Más comprados" : "## Más comprados"}
${ranking || "_(todavía no hay datos)_"}

${varias ? "### Principales proveedores" : "## Principales proveedores"}
${rankingProveedores || "_(todavía no hay datos)_"}`;
    })
    .join("\n\n");

  const cabeceraGeneral = `- **Facturas escaneadas:** ${unidadesMd(numFacturas)}
- **Periodo:** ${periodo}${varias ? `\n- **Monedas:** ${porMoneda.map((m) => m.moneda).join(", ")}` : ""}`;

  return `# Resumen de compras

${cabeceraGeneral}

${secciones}
`;
};
