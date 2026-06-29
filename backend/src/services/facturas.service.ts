import { AppDataSource } from "../config/database";
import { env } from "../config/env";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";
import { AppError } from "../utils/errors";
import { crearArchivoTexto, borrarPermanente, combinarContenido } from "./archivos.service";
import { actualizarDescripcionManual } from "./rag.service";
import { pareceFacturaConImportes } from "./extraccion.service";

// Exportada para que carpetas.service.ts pueda bloquear mover/renombrar esta
// ruta exacta (ver moverCarpetaConContenido): resumen-ventas.md y los
// resumen-<archivo>.md se regeneran SIEMPRE en esta ruta fija, así que si la
// carpeta se mueve/renombra, la próxima regeneración crea una copia nueva
// aquí mientras la vieja queda huérfana (desactualizada) en la ubicación
// nueva — quedan dos copias activas, una sin actualizar nunca más.
export const CARPETA_FACTURAS = "/facturas";

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
interface DatosFactura {
  numero?: string;
  archivoNombre?: string;
  fecha?: string;
  emisor?: string;
  cliente?: string;
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
    cliente: { type: "string" },
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
        "Extrae TODOS los datos de la factura del texto y devuélvelos en JSON. Rellena: numero (nº de factura), fecha (ISO YYYY-MM-DD), emisor (quién la emite), cliente (a quién se factura), moneda (código ISO de 3 letras de la divisa de los importes: EUR para € o euros, USD para $ o dólares, GBP para £ o libras, etc.; si no se indica ninguna, usa EUR), subtotal, iva, total, y lineas (un objeto por artículo: descripcion, cantidad, precioUnit, total). Rellena TODOS los campos que aparezcan en el texto; no dejes vacío lo que sí está. Los importes como números, sin símbolo de moneda. No inventes datos que no aparezcan.",
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

// Crea un archivo de texto reemplazando cualquier otro activo con el mismo nombre
// en la carpeta (para no acumular duplicados de los .md de resumen).
const reemplazarArchivoTexto = async (
  usuarioId: string,
  nombre: string,
  carpeta: string,
  contenido: string,
): Promise<void> => {
  const repo = AppDataSource.getRepository(Archivo);
  const existentes = await repo.find({
    where: { nombre, carpeta, propietario: { id: usuarioId } },
  });
  for (const a of existentes) {
    // Solo se borra si de verdad es un .md generado por este mismo mecanismo
    // (crearArchivoTexto le pone mimeType "text/markdown" SIEMPRE a los .md).
    // "resumen-ventas.md"/"resumen-<archivo>.md" son nombres que este sistema
    // trata como propios, pero por coincidencia (o porque alguien renombra/
    // mueve un archivo real a propósito) podría existir un archivo REAL con
    // ese mismo nombre+carpeta — sin este filtro, la próxima regeneración lo
    // borraría para siempre (borrarPermanente, sin pasar por la papelera)
    // solo por compartir nombre. Si no es un .md nuestro, se deja intacto;
    // a costa de que pueda quedar un nombre duplicado, mucho mejor que perder
    // datos del usuario.
    if (a.mimeType !== "text/markdown") {
      console.warn(
        `[facturas] "${nombre}" en ${carpeta} coincide con un archivo real (no se borra): ${a.id}`,
      );
      continue;
    }
    await borrarPermanente(a.id, usuarioId);
  }
  await crearArchivoTexto(usuarioId, nombre, carpeta, contenido);
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

// 8 caracteres del UUID del archivo (sin guiones), como sufijo estable e
// independiente del nombre. Evita que dos archivos distintos con el mismo
// nombre (en carpetas distintas) generen el mismo resumen-<nombre>.md y se
// pisen entre sí — antes el nombre del resumen dependía solo de
// archivo.nombre, así que dos "factura.pdf" en carpetas distintas competían
// por el mismo "resumen-factura.md".
const idCortoDeArchivo = (archivoId: string): string => archivoId.replace(/-/g, "").slice(0, 8);

// Nombre del archivo de resumen a partir del nombre original (sin extensión,
// caracteres no seguros sustituidos) más el sufijo de archivo.id — más fácil
// de relacionar a simple vista con el archivo original en el explorador que
// el número de factura/UUID completo, pero sin las colisiones de antes.
const nombreResumenFactura = (nombreOriginal: string, archivoId: string): string => {
  const punto = nombreOriginal.lastIndexOf(".");
  const base = punto > 0 ? nombreOriginal.slice(0, punto) : nombreOriginal;
  return `resumen-${base.replace(/[^\w.-]/g, "_")}-${idCortoDeArchivo(archivoId)}.md`;
};

// Localiza dónde vive ACTUALMENTE la carpeta de facturas del usuario: la del
// resumen-ventas.md activo, si ya existe alguno, o /facturas por defecto si
// todavía no se ha generado ningún resumen (cuenta nueva / primera factura).
// La usan tanto el resumen agregado como el fallback de cada resumen
// INDIVIDUAL nuevo (ver más abajo) — así, si el usuario mueve esa carpeta
// mientras hay varias facturas escaneándose a la vez, las que aún no tenían
// resumen propio (primera vez que se crea el suyo) aterrizan junto a las
// demás en la ubicación nueva, en vez de recrear /facturas en la raíz.
const buscarResumenVentasArchivo = (usuarioId: string): Promise<Archivo | null> =>
  AppDataSource.getRepository(Archivo).findOne({
    where: { nombre: "resumen-ventas.md", propietario: { id: usuarioId } },
  });

const localizarCarpetaFacturas = async (usuarioId: string): Promise<string> => {
  const existente = await buscarResumenVentasArchivo(usuarioId);
  return existente?.carpeta ?? CARPETA_FACTURAS;
};

// Localiza el archivo "resumen-ventas.md" activo (null si todavía no hay
// ninguna factura escaneada). Para "pásame/dame el resumen [de todo/de
// ventas]" en el chat: devuelve el archivo concreto para leer su contenido
// y ofrecer el botón "Abrir", en vez de recalcular las estadísticas aparte.
export const localizarResumenVentas = (usuarioId: string): Promise<Archivo | null> =>
  buscarResumenVentasArchivo(usuarioId);

// Localiza el resumen individual de un archivo (activo o en la papelera) por
// su sufijo "-<idCorto>.md" — estable mientras exista el archivo, sin
// importar en qué carpeta esté ni cómo se llame ahora. null si nunca se generó.
// Exportada para que archivos.service.ts mantenga el resumen sincronizado con
// el ciclo de vida del archivo original (si se borra/restaura/borra para
// siempre la factura, su resumen sigue el mismo camino).
export const localizarResumenDeArchivo = async (
  usuarioId: string,
  archivoId: string,
): Promise<Archivo | null> => {
  const repo = AppDataSource.getRepository(Archivo);
  const encontrado = await repo
    .createQueryBuilder("a")
    .where("a.propietarioId = :u", { u: usuarioId })
    .andWhere("a.nombre LIKE :p", { p: `%-${idCortoDeArchivo(archivoId)}.md` })
    .andWhere("a.mimeType = :m", { m: "text/markdown" })
    .withDeleted()
    .getOne();
  return encontrado ?? null;
};

// Como reemplazarArchivoTexto, pero para el resumen INDIVIDUAL de un archivo:
// en vez de buscar por nombre+carpeta exactos (que cambian si se renombra el
// archivo original), busca por el sufijo "-<idCorto>.md" — estable mientras
// exista el archivo — así encuentra y sustituye el resumen viejo aunque el
// archivo se haya renombrado entre medias (antes se quedaba huérfano con el
// nombre antiguo hasta volver a escanear a mano). Tampoco fija la carpeta de
// búsqueda a /facturas: si el usuario movió/renombró esa carpeta (o solo este
// resumen suelto), lo encuentra donde esté y actualiza ahí mismo — solo usa
// /facturas por defecto si todavía no existía ninguno.
const reemplazarResumenDeArchivo = async (
  usuarioId: string,
  archivoId: string,
  nuevoNombre: string,
  contenido: string,
): Promise<void> => {
  const repo = AppDataSource.getRepository(Archivo);
  // Solo activos: uno ya en la papelera no es "la ubicación actual" del
  // resumen, es un huérfano de un ciclo de vida anterior — no debe
  // resucitarse ni dictar dónde escribir el nuevo (lo gestiona por separado
  // `sincronizarResumenFactura`, que sigue el ciclo de vida del archivo).
  const existentes = await repo
    .createQueryBuilder("a")
    .where("a.propietarioId = :u", { u: usuarioId })
    .andWhere("a.nombre LIKE :p", { p: `%-${idCortoDeArchivo(archivoId)}.md` })
    .andWhere("a.eliminadoEn IS NULL")
    .getMany();
  let carpetaDestino: string | null = null;
  for (const a of existentes) {
    // Misma protección que en reemplazarArchivoTexto: nunca borrar algo que
    // no sea de verdad un .md generado por este mecanismo.
    if (a.mimeType !== "text/markdown") {
      console.warn(
        `[facturas] resumen de "${nuevoNombre}" coincide con un archivo real (no se borra): ${a.id}`,
      );
      continue;
    }
    carpetaDestino = a.carpeta; // sigue al resumen a su ubicación actual
    await borrarPermanente(a.id, usuarioId);
  }
  // Resumen INDIVIDUAL nuevo (este archivo no tenía uno todavía): en vez de
  // /facturas fijo, sigue a donde esté ahora el resto de resúmenes — antes,
  // si el usuario movía /facturas mientras otras facturas seguían
  // escaneándose, las que aún no tenían resumen propio recreaban /facturas
  // en la raíz en vez de aterrizar junto a las demás en la ubicación nueva.
  if (carpetaDestino === null) carpetaDestino = await localizarCarpetaFacturas(usuarioId);
  await crearArchivoTexto(usuarioId, nuevoNombre, carpetaDestino, contenido);
};

// Formatea una fecha ISO (YYYY-MM-DD) como DD/MM/YYYY para mostrar al usuario.
export const formatearFecha = (iso: string): string => {
  const [anio, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${anio}`;
};

// Serializa tareas por usuario: las que llegan para el mismo usuario se
// encadenan en vez de correr a la vez. Necesario porque varias facturas
// escaneándose a la vez (subida múltiple / "escanea todas") acaban
// regenerando el MISMO archivo "resumen-ventas.md" (borrar+crear): sin
// serializar, dos ejecuciones a la vez podían dejar dos copias del .md o
// competir en el borrado. Exportada (como `enSerieFacturas`) para que
// carpetas.service.ts encole en esta MISMA cola las operaciones que cambian
// dónde vive /facturas (mover/renombrar/borrar esa carpeta): sin esto, mover
// la carpeta justo mientras se está escaneando una factura podía entrelazarse
// con la regeneración en curso (cada una lee/escribe la ubicación por su
// cuenta) y acabar creando una /facturas duplicada con un resumen que
// referencia una clave de MinIO inconsistente (no se podía abrir).
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

// Wrapper serializado de reemplazarResumenDeArchivo: comparte la MISMA cola
// (`colasPorUsuario`, por usuario) que regenerarResumenVentasSerie. Sin esto,
// dos disparadores casi simultáneos para EL MISMO archivo (p. ej. renombrarlo
// dos veces rápido, o renombrarlo justo cuando se está reescaneando) podían
// competir: ambos leen "el resumen viejo" antes de que el otro lo borre, y el
// segundo borrarPermanente lanza 404 (ya no existe) y aborta esa regeneración
// a medias, dejando el resumen con el nombre equivocado o sin crear.
const reemplazarResumenDeArchivoSerie = (
  usuarioId: string,
  archivoId: string,
  nuevoNombre: string,
  contenido: string,
): Promise<void> =>
  enSerie(usuarioId, () => reemplazarResumenDeArchivo(usuarioId, archivoId, nuevoNombre, contenido));

// Prioridad dentro de cada cola: 0 = alta (PDFs y demás, rápidos: pdf-parse/
// texto plano, sin IA de visión), 1 = baja (imágenes, o trabajo derivado de
// ellas). Dentro de `colaExtraccion`, una factura PDF nueva (alta) siempre se
// atiende antes que una imagen ya OCR'eada (baja) que llegó primero.
export const PRIORIDAD_ALTA = 0;
export const PRIORIDAD_BAJA = 1;

interface TareaCola {
  prioridad: number;
  ejecutar: () => Promise<void>;
}

// Dos colas en vez de una: `colaOcr` (imágenes, necesitan deepseek-ocr) y
// `colaExtraccion` (extracción de datos de factura con qwen — PDFs directos,
// o imágenes ya OCR'eadas). El motivo: deepseek-ocr (~9.4GB de VRAM medidos
// en una 4070) y qwen2.5-coder:14b no caben juntos en la GPU, así que cada
// vez que el pipeline de UN archivo pasa de OCR a extracción, Ollama tiene que
// descargar un modelo para cargar el otro. Procesando por fases en vez de por
// archivo (todo el OCR pendiente con deepseek-ocr cargado, luego toda la
// extracción pendiente con qwen cargado) ese cambio de modelo pasa de "uno
// por imagen" a "uno por lote".
const colaOcr: TareaCola[] = [];
const colaExtraccion: TareaCola[] = [];
let procesandoColas = false;

// Array.prototype.sort es estable desde ES2019: dentro de la misma prioridad
// se mantiene el orden de llegada (FIFO).
const sacarSiguiente = (cola: TareaCola[]): TareaCola | undefined => {
  if (cola.length === 0) return undefined;
  cola.sort((a, b) => a.prioridad - b.prioridad);
  return cola.shift();
};

// Antes de cada paso de OCR, si ha llegado una factura nueva (prioridad alta)
// a `colaExtraccion`, se atiende primero — así una factura nunca espera a que
// termine un lote entero de imágenes, solo a que termine la que esté en
// marcha en ese instante (no hay interrupción de una request ya en marcha
// con Ollama: se descartó por demasiado costosa/arriesgada, ver conversación).
const procesarColas = async (): Promise<void> => {
  if (procesandoColas) return;
  procesandoColas = true;
  while (colaOcr.length > 0 || colaExtraccion.length > 0) {
    const urgente = colaExtraccion.some((t) => t.prioridad === PRIORIDAD_ALTA)
      ? sacarSiguiente(colaExtraccion)
      : undefined;
    const siguiente = urgente ?? sacarSiguiente(colaOcr) ?? sacarSiguiente(colaExtraccion);
    if (!siguiente) break;
    await siguiente.ejecutar();
  }
  procesandoColas = false;
};

const encolarEnCola = <T>(
  cola: TareaCola[],
  prioridad: number,
  tarea: () => Promise<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    cola.push({ prioridad, ejecutar: () => tarea().then(resolve, reject) });
    void procesarColas();
  });

// Encola una tarea de OCR/indexado de una imagen (fase 1: deepseek-ocr).
export const encolarOcr = <T>(tarea: () => Promise<T>): Promise<T> =>
  encolarEnCola(colaOcr, PRIORIDAD_BAJA, tarea);

// Encola una tarea de extracción de datos de factura (fase 2: qwen). Alta
// prioridad por defecto (PDFs); pasar PRIORIDAD_BAJA para las que vienen de
// una imagen ya OCR'eada.
export const encolarExtraccion = <T>(
  tarea: () => Promise<T>,
  prioridad: number = PRIORIDAD_ALTA,
): Promise<T> => encolarEnCola(colaExtraccion, prioridad, tarea);

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
    relations: { propietario: true },
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
    if (!tieneImportes || !tieneIdentificacion) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "no_factura" });
      // Si un escaneo anterior llegó a guardar una factura (inventada) para este
      // archivo, ahora que sabemos que NO es factura la eliminamos: si no, seguiría
      // apareciendo en "abre X" y en la analítica pese a este resultado.
      const { affected } = await AppDataSource.getRepository(Factura)
        .createQueryBuilder()
        .delete()
        .where(`"archivoId" = :a AND "propietarioId" = :u`, { a: archivo.id, u: usuarioId })
        .execute();
      // Si de verdad había una factura guardada de un escaneo anterior, ya no
      // cuenta: regeneramos resumen-ventas.md para que deje de incluirla.
      if (affected) {
        await regenerarResumenVentasSerie(usuarioId).catch((err) =>
          console.error("[facturas] Error al regenerar resumen-ventas (no crítico):", err),
        );
      }
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
      cliente: datos.cliente,
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

    // Resumen por factura + regenerar el resumen global de ventas.
    // Si falla la creación de los .md (p. ej. MinIO), logueamos pero no abortamos:
    // los datos de la factura ya están guardados en BD y eso es lo importante.
    try {
      await reemplazarResumenDeArchivoSerie(
        usuarioId,
        archivo.id,
        nombreResumenFactura(archivo.nombre, archivo.id),
        resumenFacturaMd(datos),
      );
      await regenerarResumenVentasSerie(usuarioId);
    } catch (err) {
      console.error("[facturas] Error al crear archivos de resumen (no crítico):", err);
    }

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
  void encolarExtraccion(() =>
    escanearFactura(usuarioId, archivoId, { pista })
      .then(() => undefined)
      // El estado (no_factura/error) ya lo deja escanearFactura en su catch;
      // aquí solo logueamos porque no hay nadie esperando la promesa.
      .catch((err) =>
        console.error(`[facturas] Escaneo manual de "${archivo.nombre}" falló:`, err),
      ),
  );
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

// Si el archivo (ya renombrado/movido) tiene una factura escaneada, regenera
// su resumen-<nombre>-<id>.md con el nombre actual. Sin esto, renombrar una
// factura ("factura_03.pdf" -> "factura_v2.pdf") dejaba su resumen individual
// con el nombre viejo hasta volver a escanearla a mano — `reemplazarResumenDeArchivo`
// lo localiza por el sufijo de archivo.id (estable) y no por el nombre.
// Pensada para llamarse "fire-and-forget" desde archivos.service.ts al renombrar.
export const actualizarResumenFacturaSiExiste = async (
  usuarioId: string,
  archivo: Archivo,
): Promise<void> => {
  const { encontrada, resumen } = await obtenerFactura(usuarioId, archivo.id, archivo.nombre);
  if (!encontrada || !resumen) return;
  await reemplazarResumenDeArchivoSerie(
    usuarioId,
    archivo.id,
    nombreResumenFactura(archivo.nombre, archivo.id),
    resumen,
  );
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
  const { where, params } = construirFiltro(usuarioId, filtro);
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  // Ranking TOP-N POR MONEDA: no se puede sumar unidades de productos facturados
  // en divisas distintas en una misma tabla. ROW_NUMBER particionado por moneda
  // da las N primeras de cada divisa; el llamador (rankingMd) las agrupa en una
  // sección por moneda.
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
         WHERE ${where}
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
  const { where, params } = construirFiltro(usuarioId, rest);
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
  archivoId: string | null;
  archivoNombre: string | null;
  numero: string;
  fecha: string;
  total: number;
  moneda: string;
};

// Lista (no agrega) las facturas que cumplen el filtro, con el archivo asociado
// para poder ofrecer un botón "Abrir" por cada una. El campo `producto` no
// aplica aquí (no hay JOIN con lineas_factura, igual que en totalesFacturado).
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
  const { producto: _producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, rest);
  const [{ total }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS total FROM "facturas" f LEFT JOIN "archivos" a ON a."id" = f."archivoId" WHERE ${where}`,
    params,
  );
  const filas: { archivoid: string | null; archivonombre: string | null; numero: string; fecha: string; total: string; moneda: string }[] =
    await AppDataSource.query(
      `SELECT a."id" AS archivoid, a."nombre" AS archivonombre, f."numero" AS numero,
              f."fecha"::text AS fecha, f."total" AS total, f."moneda" AS moneda
       FROM "facturas" f
       LEFT JOIN "archivos" a ON a."id" = f."archivoId"
       WHERE ${where}
       ORDER BY f."fecha" DESC
       LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
      params,
    );
  return {
    filas: filas.map((r) => ({
      archivoId: r.archivoid,
      archivoNombre: r.archivonombre,
      numero: r.numero,
      fecha: r.fecha,
      total: Number(r.total),
      moneda: r.moneda || "EUR",
    })),
    total: Number(total),
    paginas: Math.max(1, Math.ceil(Number(total) / limite)),
  };
};

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
  const filas: { archivoid: string | null; archivonombre: string | null; numero: string; fecha: string; total: string; moneda: string }[] =
    await AppDataSource.query(
      `SELECT a."id" AS archivoid, a."nombre" AS archivonombre, f."numero" AS numero,
              f."fecha"::text AS fecha, f."total" AS total, f."moneda" AS moneda
       FROM "facturas" f
       JOIN "archivos" a ON a."id" = f."archivoId"
       WHERE f."propietarioId" = $1 AND a."eliminadoEn" IS NOT NULL
       ORDER BY a."eliminadoEn" DESC
       LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
      [usuarioId],
    );
  return {
    filas: filas.map((r) => ({
      archivoId: r.archivoid,
      archivoNombre: r.archivonombre,
      numero: r.numero,
      fecha: r.fecha,
      total: Number(r.total),
      moneda: r.moneda || "EUR",
    })),
    total: Number(total),
    paginas: Math.max(1, Math.ceil(Number(total) / limite)),
  };
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
  const { where, params } = construirFiltro(usuarioId, rest);
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  // TOP-N POR MONEDA: el gasto de un cliente en € y en $ son cifras distintas
  // que no se suman. ROW_NUMBER particionado por moneda da las N de cada divisa.
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
  const { where, params } = construirFiltro(usuarioId, {});
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

const regenerarResumenVentas = async (usuarioId: string): Promise<void> => {
  const { numFacturas, primeraFecha, ultimaFecha, porMoneda } = await resumenVentas(usuarioId);

  if (numFacturas === 0) {
    // Sin facturas no hay nada que resumir: si quedaba un resumen-ventas.md
    // de antes (p. ej. se borraron/movieron todas), se borra en vez de
    // reescribirse con ceros — y como era el único motivo para que /facturas
    // existiera, la carpeta deja de "resucitar" sola. Solo debe reaparecer al
    // subir o escanear una factura nueva (entonces SÍ hay datos que mostrar).
    const repo = AppDataSource.getRepository(Archivo);
    const existente = await repo.findOne({
      where: { nombre: "resumen-ventas.md", propietario: { id: usuarioId } },
    });
    if (existente && existente.mimeType === "text/markdown") {
      await borrarPermanente(existente.id, usuarioId);
    }
    return;
  }

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

  const md = `# Resumen de ventas

${cabeceraGeneral}

${secciones}
`;
  // Sigue al resumen a su ubicación actual si el usuario movió/renombró la
  // carpeta donde vivía (ver `localizarCarpetaFacturas`). Sin esto, mover esa
  // carpeta dejaba el resumen viejo huérfano (nunca se actualizaba) y creaba
  // uno nuevo en /facturas cada vez.
  const carpetaDestino = await localizarCarpetaFacturas(usuarioId);
  await reemplazarArchivoTexto(usuarioId, "resumen-ventas.md", carpetaDestino, md);
};

// Wrapper público: serializa por usuario (ver `enSerie` más arriba) para que
// dos operaciones a la vez sobre archivos/facturas del mismo usuario (subida
// múltiple, borrar+restaurar rápido...) no compitan reescribiendo a la vez el
// mismo "resumen-ventas.md". Lo usan tanto este servicio como
// `archivos.service.ts`/`carpetas.service.ts` cada vez que cambia qué
// facturas están activas (se borran, se restauran, o se crean).
export const regenerarResumenVentasSerie = (usuarioId: string): Promise<void> =>
  enSerie(usuarioId, () => regenerarResumenVentas(usuarioId));
