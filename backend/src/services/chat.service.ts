import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { Archivo } from "../entities/Archivo";
import {
  buscarArchivos,
  listarArchivos,
  copiarArchivo,
  actualizarArchivo,
  eliminarArchivo,
  crearArchivoTexto,
  listarPapelera,
  restaurarArchivo,
  restaurarTodo,
  borrarPermanente,
  vaciarPapelera,
  eliminarTodosLosArchivos,
  leerTextoArchivo,
  estadisticasUsuario,
} from "./archivos.service";
import {
  crearCarpeta,
  listarTodasCarpetas,
  eliminarCarpetaConContenido,
  vaciarCarpeta,
  vaciarTodo,
  eliminarTodasCarpetas,
  moverCarpetaConContenido,
  copiarCarpetaConContenido,
  normalizarRuta,
  carpetaExiste,
} from "./carpetas.service";
import { buscarSemantica } from "./rag.service";
import {
  escanearFactura,
  obtenerFactura,
  ventasTop,
  totalesFacturado,
  clientesTop,
  listarFacturas,
  listarFacturasPapelera,
  localizarResumenVentas,
  asegurarFacturasEscaneadas,
  rankingMd,
  totalesMd,
  clientesTopMd,
  listadoFacturasMd,
  formatearFecha,
  encolarExtraccion,
  PRIORIDAD_ALTA,
  PRIORIDAD_BAJA,
  type FiltroFacturas,
} from "./facturas.service";
import { SYSTEM_PROMPT, TOOLS } from "./chat.tools";

// Helpers de rutas .
const padreRuta = (r: string): string => {
  const s = normalizarRuta(r);
  if (s === "/") return "/";
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
};
const hojaRuta = (r: string): string => {
  const s = normalizarRuta(r);
  return s === "/" ? "" : s.slice(s.lastIndexOf("/") + 1);
};
const unirRuta = (padre: string, nombre: string): string =>
  padre === "/" ? `/${nombre}` : `${padre}/${nombre}`;

// Quita tildes (á→a, é→e...) para que los pre-flights de intención reconozcan
// verbos con pronombre enclítico pegado ("bórralo", "elimínala", "vacíalas"),
// que desplazan el acento y no casan con los patrones normales ni con \b
// (no hay límite de palabra entre "borra" y "lo" en "borralo").
const quitarTildes = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Distancia de edición (Levenshtein) y similitud normalizada [0..1], para el
// respaldo "fuzzy" de resolverArchivo: si la búsqueda exacta por substring no
// encuentra nada (p.ej. una errata como "nustras" por "nuestras"), se compara
// el nombre pedido contra los reales y se acepta el más parecido si supera el
// umbral. O(n·m) por par, pero solo se usa en el camino de fallo (no el normal).
const distanciaLev = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const fila = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = fila[0];
    fila[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return fila[n];
};
const similitud = (a: string, b: string): number => {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - distanciaLev(a, b) / max;
};

// quitarTildes no cambia la longitud de la cadena (cada letra con tilde se
// queda en una sola letra sin tilde), así que los índices de un match hecho
// sobre el texto sin tildes coinciden 1 a 1 con el texto original. Esto deja
// recuperar el grupo capturado CON sus tildes/mayúsculas originales (para que
// un nombre de archivo acentuado, ej. "Tecnología.pdf", no se busque luego sin
// tilde) aunque el verbo se haya detectado sobre la versión sin tildes.
const grupoOriginal = (original: string, m: RegExpMatchArray, grupo = 1): string => {
  const capturado = m[grupo] ?? "";
  const offset = m[0].indexOf(capturado);
  const inicio = (m.index ?? 0) + Math.max(offset, 0);
  return original.slice(inicio, inicio + capturado.length);
};

// Recorta un fragmento de RAG (hasta ~1000 chars) a solo el trozo alrededor de
// donde aparece el término buscado, en vez de devolver el chunk entero — para
// que "qué documento habla de X" muestre el nombre + una frase corta, no un
// párrafo completo. Si el término no aparece tal cual (la búsqueda es semántica,
// puede encontrar contenido relacionado sin la palabra literal), recorta desde
// el principio.
const extraerFragmento = (texto: string, tema: string, ventana = 60): string => {
  const idx = quitarTildes(texto.toLowerCase()).indexOf(quitarTildes(tema.toLowerCase()));
  if (idx === -1) {
    return texto.length > 160 ? `${texto.slice(0, 160).trim()}...` : texto;
  }
  const inicio = Math.max(0, idx - ventana);
  const fin = Math.min(texto.length, idx + tema.length + ventana);
  const recorte = texto.slice(inicio, fin).trim();
  return `${inicio > 0 ? "..." : ""}${recorte}${fin < texto.length ? "..." : ""}`;
};

// Extrae una ruta de carpeta válida de los args. El modelo a veces omite "ruta"
// o la pone bajo otra clave; sin esto, String(undefined) === "undefined" creaba
// carpetas literales "/undefined".
const extraerRuta = (
  args: Record<string, unknown>,
  ...claves: string[]
): string | undefined => {
  const alias = claves.length ? claves : ["ruta", "carpeta", "nombre", "path"];
  for (const clave of alias) {
    const candidato = args[clave];
    if (typeof candidato === "string" && candidato.trim()) return candidato;
  }
  return undefined;
};

// --- Tipos del API de Ollama (/api/chat) ---
interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}
interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
}

// Mensaje que llega del frontend.
export interface MensajeChat {
  rol: "usuario" | "bot";
  contenido: string;
}


// Localiza un archivo por su nombre. Devuelve el archivo, un error o varias opciones.
const resolverArchivo = async (
  usuarioId: string,
  nombre: string,
): Promise<{
  archivo?: Archivo;
  error?: string;
  opciones?: { id: string; nombre: string; carpeta: string }[];
  // true cuando las `opciones` NO son coincidencias exactas sino sugerencias por
  // parecido (el nombre pedido no existía tal cual): el caller muestra "¿Querías
  // decir...?" en vez de "Hay varias coincidencias".
  sugerencia?: boolean;
}> => {
  let lista = await buscarArchivos(usuarioId, nombre);
  if (lista.length === 0) {
    // El modelo a veces adivina una extensión que no es la real (ej. pide
    // "X.md" para preguntar "qué dice X" sin que el usuario diera extensión,
    // y el archivo real es "X.pdf"): la búsqueda por substring falla del todo
    // por la extensión aunque el nombre base sí exista. Reintenta sin ella.
    const sinExtension = nombre.replace(/\.[a-z0-9]{1,5}$/i, "");
    if (sinExtension !== nombre) lista = await buscarArchivos(usuarioId, sinExtension);
  }
  // Respaldo fuzzy: si la búsqueda exacta por substring no encontró nada, suele
  // ser una errata ("nustras armas" por "nuestras armas") o una palabra de más.
  // Se comparan los nombres reales por similitud (Levenshtein) y se devuelven los
  // más parecidos como SUGERENCIAS para que el usuario elija (nunca se auto-
  // resuelve: el usuario quiere confirmar, no que se adivine el archivo).
  if (lista.length === 0) {
    const objetivo = quitarTildes(nombre.replace(/\.[a-z0-9]{1,5}$/i, "").toLowerCase()).trim();
    if (objetivo.length >= 4) {
      const todos = (await listarArchivos(usuarioId, undefined, 1, 500)).archivos;
      const conSim = todos
        .map((a) => ({
          a,
          s: similitud(quitarTildes(a.nombre.replace(/\.[a-z0-9]{1,5}$/i, "").toLowerCase()), objetivo),
        }))
        .filter((x) => x.s >= 0.6)
        .sort((x, y) => y.s - x.s)
        .slice(0, 5);
      if (conSim.length > 0) {
        return {
          opciones: conSim.map((x) => ({ id: x.a.id, nombre: x.a.nombre, carpeta: x.a.carpeta })),
          sugerencia: true,
        };
      }
    }
  }
  if (lista.length === 0) return { error: `No encontré ningún archivo que coincida con "${nombre}".` };
  const exacto = lista.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase());
  if (exacto) return { archivo: exacto };
  if (lista.length === 1) return { archivo: lista[0] };
  // El .md de resumen que se genera automáticamente al escanear una factura
  // (resumen-<nombre original>.md, en /facturas — ver `nombreResumenFactura`
  // en facturas.service.ts) coincide con casi cualquier búsqueda por el nombre
  // de esa factura, generando una ambigüedad constante con el archivo real.
  // Se descarta de los candidatos salvo que sea la única coincidencia (pedirlo
  // por su nombre completo ya se resuelve arriba, y listar la carpeta entera
  // no pasa por aquí, así que sigue mostrándolo).
  const sinResumenes = lista.filter((a) => !/^resumen-/i.test(a.nombre));
  if (sinResumenes.length === 1) return { archivo: sinResumenes[0] };
  const final = sinResumenes.length > 0 ? sinResumenes : lista;
  return { opciones: final.map((a) => ({ id: a.id, nombre: a.nombre, carpeta: a.carpeta })) };
};

// Localiza una carpeta EXISTENTE por nombre o ruta completa. Si el argumento ya
// parece una ruta (empieza por "/"), se valida que exista (si no, error: así el
// caller puede intentar resolverlo como archivo en su lugar). Si es solo un
// nombre (ej. "tmp"), busca entre TODAS las carpetas del usuario cualquiera
// cuyo último tramo coincida: no hace falta dar la ruta completa, igual que
// ya pasa con archivos.
const resolverCarpeta = async (
  usuarioId: string,
  nombreORuta: string,
): Promise<{ ruta?: string; error?: string; opciones?: string[]; sugerencia?: boolean }> => {
  const texto = nombreORuta.trim();
  if (texto.startsWith("/")) {
    const ruta = normalizarRuta(texto);
    if (await carpetaExiste(usuarioId, ruta)) return { ruta };
    // El modelo a veces antepone "/" a un nombre suelto (ej. pasa "/tmp" cuando
    // el usuario solo dijo "tmp" y la carpeta real está en otra ubicación, p.ej.
    // "/demo/tmp"); si la ruta exacta no existe, se reintenta por nombre suelto
    // antes de rendirse, en vez de fallar solo porque el modelo añadió la barra.
  }
  const todas = await listarTodasCarpetas(usuarioId);
  const buscado = hojaRuta(texto).toLowerCase();
  const coincidencias = todas.filter((c) => hojaRuta(c.ruta).toLowerCase() === buscado);
  if (coincidencias.length === 0) {
    // Respaldo fuzzy (igual que en resolverArchivo): el nombre exacto no existe,
    // probablemente una errata. Se sugieren las carpetas con el último tramo más
    // parecido para que el usuario elija; nunca se auto-resuelve.
    const objetivo = quitarTildes(buscado).trim();
    if (objetivo.length >= 3) {
      const cercanas = todas
        .map((c) => ({ c, s: similitud(quitarTildes(hojaRuta(c.ruta).toLowerCase()), objetivo) }))
        .filter((x) => x.s >= 0.6)
        .sort((x, y) => y.s - x.s)
        .slice(0, 5);
      if (cercanas.length > 0) return { opciones: cercanas.map((x) => x.c.ruta), sugerencia: true };
    }
    return { error: `No encontré ninguna carpeta llamada "${nombreORuta}".` };
  }
  if (coincidencias.length === 1) return { ruta: coincidencias[0].ruta };
  return { opciones: coincidencias.map((c) => c.ruta) };
};

// Localiza un archivo dentro de la papelera por su nombre.
const resolverEnPapelera = async (
  usuarioId: string,
  nombre: string,
): Promise<{
  archivo?: Archivo;
  error?: string;
  opciones?: { id: string; nombre: string; carpeta: string }[];
  sugerencia?: boolean;
}> => {
  const lista = (await listarPapelera(usuarioId)).filter((a) =>
    a.nombre.toLowerCase().includes(nombre.toLowerCase()),
  );
  if (lista.length === 0)
    return { error: `No hay ningún archivo en la papelera que coincida con "${nombre}".` };
  const exacto = lista.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase());
  if (exacto) return { archivo: exacto };
  if (lista.length === 1) return { archivo: lista[0] };
  return { opciones: lista.map((a) => ({ id: a.id, nombre: a.nombre, carpeta: a.carpeta })) };
};

// Tipo de las opciones que se ofrecen al pedir aclaración: objeto (archivo,
// con id+nombre+carpeta) cuando viene de resolverArchivo/resolverEnPapelera, o
// string (ruta completa) cuando viene de resolverCarpeta. El `id` solo está en
// el caso archivo y es lo que permite ofrecer el botón "Abrir" en la tabla.
type OpcionAclaracion = { id: string; nombre: string; carpeta: string } | string;

// Cuando una tool no puede decidir entre varias coincidencias y pregunta al
// usuario, se recuerda aquí qué se estaba intentando hacer (tool + argumentos
// originales) para poder completarlo en el SIGUIENTE mensaje si el usuario
// responde con una de las opciones ofrecidas. Sin esto, la respuesta de
// aclaración (ej. "factura_X.pdf (/test)") se trata como un mensaje nuevo sin
// contexto -el chat solo envía el último mensaje- y el modelo hace otra cosa
// (ej. escanea la factura en vez de completar el renombrado que se había
// pedido). Se descarta a los 5 minutos para no aplicar un estado obsoleto a
// una conversación ya distinta.
const pendientesAclaracion = new Map<
  string,
  {
    tool: string;
    args: Record<string, unknown>;
    clave: "nombre" | "ruta";
    opciones: OpcionAclaracion[];
    ts: number;
  }
>();
const TTL_ACLARACION_MS = 5 * 60 * 1000;

const registrarAclaracion = (
  usuarioId: string,
  tool: string,
  args: Record<string, unknown>,
  clave: "nombre" | "ruta",
  opciones: OpcionAclaracion[],
  sugerencia = false,
) => {
  pendientesAclaracion.set(usuarioId, { tool, args, clave, opciones, ts: Date.now() });
  return { necesita_aclaracion: true, opciones, sugerencia };
};

// Encabezado de la pregunta de aclaración. Si las opciones son SUGERENCIAS por
// parecido (el nombre pedido no existía tal cual), pregunta "¿Querías decir...?";
// si son varias coincidencias reales del nombre dado, "¿cuál quieres?".
const cabeceraAclaracion = (sugerencia?: boolean): string =>
  sugerencia
    ? "No encontré ese nombre exacto. ¿Querías decir alguno de estos?"
    : "Hay varias coincidencias, ¿cuál quieres?";

// Construye el mensaje completo de aclaración (encabezado + lista de opciones).
const mensajeAclaracion = (opciones: OpcionAclaracion[], sugerencia?: boolean): string => {
  const lista = opciones
    .map((o) =>
      typeof o === "string"
        ? `- ${o}`
        : `- ${o.nombre}${o.carpeta && o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`,
    )
    .join("\n");
  return `${cabeceraAclaracion(sugerencia)}\n\n${lista}`;
};

// Tools que solo CONSULTAN (no mutan nada): para estas tiene sentido ofrecer
// un botón "Abrir" además de completar la acción, porque elegir una opción no
// hace nada irreversible. El resto (mover/copiar/renombrar/eliminar/restaurar...)
// solo ofrece "Elegir": no tiene sentido previsualizar un archivo que se va a
// mover o borrar, y dos botones ahí solo añade confusión.
const TOOLS_LECTURA = new Set(["leer_archivo", "obtener_factura"]);

// Una fila de la tabla clicable de aclaración: `etiqueta` es lo que se muestra,
// `valor` es lo que se manda como mensaje al pulsarla (debe coincidir con lo
// que el pre-flight de aclaración pendiente compara contra `opciones`).
// `archivoId` solo se incluye para tools de lectura (ver TOOLS_LECTURA): es lo
// que el frontend usa para decidir entre mostrar "Resumen"+"Abrir" o solo
// "Elegir".
const filaAclaracion = (
  o: OpcionAclaracion,
  lectura: boolean,
): { etiqueta: string; valor: string; archivoId?: string } =>
  typeof o === "string"
    ? { etiqueta: o, valor: o }
    : {
        etiqueta: `${o.nombre}${o.carpeta && o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`,
        valor: o.nombre,
        archivoId: lectura ? o.id : undefined,
      };

// Construye la respuesta completa de aclaración (texto markdown + tabla
// clicable equivalente) para no repetir esto en cada punto que la necesita.
// `tool` es la tool que se completará al elegir una opción (ver TOOLS_LECTURA).
const respuestaAclaracion = (
  opciones: OpcionAclaracion[],
  sugerencia: boolean | undefined,
  acciones: string[],
  tool: string,
  extra: { previo?: string; archivos?: { id: string; nombre: string }[] } = {},
): {
  respuesta: string;
  acciones: string[];
  archivos?: { id: string; nombre: string }[];
  tablaAclaracion: {
    titulo: string;
    sugerencia: boolean;
    limite: number;
    filas: { etiqueta: string; valor: string; archivoId?: string }[];
  };
} => {
  const lectura = TOOLS_LECTURA.has(tool);
  return {
    respuesta: (extra.previo ?? "") + mensajeAclaracion(opciones, sugerencia),
    acciones,
    archivos: extra.archivos,
    tablaAclaracion: {
      titulo: cabeceraAclaracion(sugerencia),
      sugerencia: sugerencia === true,
      limite: 20,
      filas: opciones.map((o) => filaAclaracion(o, lectura)),
    },
  };
};

// Traduce los argumentos de las tools de analítica (ventas_top, totales_facturas)
// a un FiltroFacturas y a un título legible para el markdown del resultado.
const filtroFacturasDesdeArgs = (
  args: Record<string, unknown>,
): { filtro: FiltroFacturas; titulo: string } => {
  const filtro: FiltroFacturas = {};
  const partes: string[] = [];

  if (Array.isArray(args.facturas)) {
    const facturas = args.facturas.map((x) => String(x).trim()).filter(Boolean);
    if (facturas.length) {
      filtro.facturas = facturas;
      partes.push(`facturas ${facturas.join(", ")}`);
    }
  }
  if (typeof args.cliente === "string" && args.cliente.trim()) {
    filtro.cliente = args.cliente.trim();
    partes.push(`cliente ${filtro.cliente}`);
  }
  if (typeof args.emisor === "string" && args.emisor.trim()) {
    filtro.emisor = args.emisor.trim();
    partes.push(`emisor ${filtro.emisor}`);
  }
  if (typeof args.producto === "string" && args.producto.trim()) {
    filtro.producto = args.producto.trim();
    partes.push(`producto "${filtro.producto}"`);
  }

  // Periodo: mes/anio tienen prioridad; si no, año suelto o desde/hasta explícitos.
  const mes = typeof args.mes === "number" ? args.mes : undefined;
  if (mes && mes >= 1 && mes <= 12) {
    const anio = typeof args.anio === "number" ? args.anio : new Date().getFullYear();
    const mm = String(mes).padStart(2, "0");
    const ultimoDia = new Date(anio, mes, 0).getDate();
    filtro.desde = `${anio}-${mm}-01`;
    filtro.hasta = `${anio}-${mm}-${ultimoDia}`;
    const nombreMes = new Date(anio, mes - 1).toLocaleString("es-ES", { month: "long" });
    partes.push(`${nombreMes} ${anio}`);
  } else {
    if (typeof args.anio === "number") {
      filtro.desde = `${args.anio}-01-01`;
      filtro.hasta = `${args.anio}-12-31`;
      partes.push(`${args.anio}`);
    }
    if (typeof args.desde === "string" && args.desde.trim()) {
      filtro.desde = args.desde.trim();
      partes.push(`desde ${filtro.desde}`);
    }
    if (typeof args.hasta === "string" && args.hasta.trim()) {
      filtro.hasta = args.hasta.trim();
      partes.push(`hasta ${filtro.hasta}`);
    }
  }

  return { filtro, titulo: partes.length ? partes.join(" · ") : "todas las facturas" };
};

// Ejecuta una herramienta contra los servicios reales (siempre con el usuario del token).
const ejecutarTool = async (
  nombre: string,
  args: Record<string, unknown>,
  usuarioId: string,
  acciones: string[],
): Promise<unknown> => {
  try {
    switch (nombre) {
      case "buscar_archivos": {
        const texto = typeof args.texto === "string" ? args.texto : "";
        const carpeta = typeof args.carpeta === "string" ? args.carpeta : undefined;
        const lista = texto
          ? await buscarArchivos(usuarioId, texto)
          : (await listarArchivos(usuarioId, carpeta, 1, 30)).archivos;
        return lista.map((a) => ({ id: a.id, nombre: a.nombre, carpeta: a.carpeta }));
      }
      case "copiar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        const r = await copiarArchivo(res.archivo!.id, usuarioId, {
          carpeta: extraerRuta(args, "carpeta", "carpeta_destino", "destino", "ruta"),
        });
        acciones.push(`Copiado "${r.nombre}" en ${r.carpeta}`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "mover_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        const carpetaArg = extraerRuta(args, "carpeta", "carpeta_destino", "destino", "ruta");
        if (!carpetaArg) return { error: "Falta indicar la carpeta destino." };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, { carpeta: carpetaArg });
        acciones.push(`Movido "${r.nombre}" a ${r.carpeta}`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "renombrar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          nombre: String(args.nuevo_nombre),
        });
        acciones.push(`Renombrado a "${r.nombre}"`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "eliminar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        await eliminarArchivo(res.archivo!.id, usuarioId);
        acciones.push(`Enviado a la papelera "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre, resumen: "Hecho." };
      }
      case "crear_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a crear." };
        const ruta = await crearCarpeta(usuarioId, rutaArg);
        acciones.push(`Carpeta creada: ${ruta}`);
        return { ok: true, ruta, resumen: "Hecho." };
      }
      case "crear_archivo": {
        const carpeta = typeof args.carpeta === "string" && args.carpeta ? args.carpeta : "/";
        const r = await crearArchivoTexto(
          usuarioId,
          String(args.nombre),
          carpeta,
          typeof args.contenido === "string" ? args.contenido : "",
        );
        acciones.push(`Archivo creado "${r.nombre}" en ${r.carpeta}`);
        return { ok: true, nombre: r.nombre, carpeta: r.carpeta, resumen: "Hecho." };
      }
      case "eliminar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a borrar." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) {
          // El modelo pudo confundir un archivo con una carpeta (ej. llamó a esta
          // tool para algo que en realidad es un archivo).
          const comoArchivo = await resolverArchivo(usuarioId, hojaRuta(rutaArg));
          if (comoArchivo.archivo) {
            await eliminarArchivo(comoArchivo.archivo.id, usuarioId);
            acciones.push(`Enviado a la papelera "${comoArchivo.archivo.nombre}"`);
            return { ok: true, nombre: comoArchivo.archivo.nombre, resumen: "Hecho." };
          }
          if (comoArchivo.opciones)
            return registrarAclaracion(usuarioId, "eliminar_archivo", {}, "nombre", comoArchivo.opciones, comoArchivo.sugerencia);
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones, res.sugerencia);
        const r = await eliminarCarpetaConContenido(usuarioId, res.ruta!);
        acciones.push(`Carpeta enviada a la papelera: ${res.ruta} (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      case "vaciar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a vaciar." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones, res.sugerencia);
        const r = await vaciarCarpeta(usuarioId, res.ruta!);
        acciones.push(`Contenido de ${res.ruta} enviado a la papelera (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      case "listar_carpetas": {
        return await listarTodasCarpetas(usuarioId);
      }
      case "borrar_todo": {
        const r = await vaciarTodo(usuarioId);
        acciones.push(
          `Borrado todo: ${r.archivos} archivo/s a la papelera y ${r.carpetas} carpeta/s eliminada/s`,
        );
        return { ok: true, archivos: r.archivos, carpetas: r.carpetas, resumen: "Hecho." };
      }
      case "borrar_todas_carpetas": {
        const r = await eliminarTodasCarpetas(usuarioId);
        acciones.push(
          `Borradas ${r.carpetas} carpeta/s y su contenido a la papelera (${r.borrados} archivo/s). Los archivos en la raíz no se han tocado.`,
        );
        return { ok: true, carpetas: r.carpetas, borrados: r.borrados, resumen: "Hecho." };
      }
      case "borrar_todos_archivos": {
        const r = await eliminarTodosLosArchivos(usuarioId);
        acciones.push(`Enviados a la papelera ${r.borrados} archivo/s. Las carpetas no se han tocado.`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      // --- Papelera ---
      case "listar_papelera": {
        const lista = await listarPapelera(usuarioId);
        return lista.map((a) => ({ nombre: a.nombre, carpeta: a.carpeta }));
      }
      case "restaurar_archivo": {
        const res = await resolverEnPapelera(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        await restaurarArchivo(res.archivo!.id, usuarioId);
        acciones.push(`Restaurado "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre, resumen: "Hecho." };
      }
      case "restaurar_todo": {
        const r = await restaurarTodo(usuarioId);
        acciones.push(`Restaurados ${r.restaurados} archivo/s de la papelera.`);
        return { ok: true, restaurados: r.restaurados, resumen: "Hecho." };
      }
      case "borrar_permanente": {
        const res = await resolverEnPapelera(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        await borrarPermanente(res.archivo!.id, usuarioId);
        acciones.push(`Borrado definitivamente "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre, resumen: "Hecho." };
      }
      case "vaciar_papelera": {
        const r = await vaciarPapelera(usuarioId);
        acciones.push(`Papelera vaciada (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      // --- Operaciones de carpeta ---
      case "mover_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a mover." };
        const destinoArg =
          typeof args.carpeta_destino === "string" && args.carpeta_destino.trim()
            ? args.carpeta_destino
            : undefined;
        if (!destinoArg) return { error: "Falta indicar la carpeta destino." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) {
          const comoArchivo = await resolverArchivo(usuarioId, hojaRuta(rutaArg));
          if (comoArchivo.archivo) {
            const r = await actualizarArchivo(comoArchivo.archivo.id, usuarioId, {
              carpeta: normalizarRuta(destinoArg),
            });
            acciones.push(`Movido "${r.nombre}" a ${r.carpeta}`);
            return { ok: true, nombre: r.nombre, resumen: "Hecho." };
          }
          if (comoArchivo.opciones)
            return registrarAclaracion(
              usuarioId,
              "mover_archivo",
              { carpeta: destinoArg },
              "nombre",
              comoArchivo.opciones,
              comoArchivo.sugerencia,
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones, res.sugerencia);
        const origen = res.ruta!;
        const destino = unirRuta(normalizarRuta(destinoArg), hojaRuta(origen));
        const r = await moverCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta movida a ${destino} (${r.movidos} archivo/s)`);
        return { ok: true, destino, movidos: r.movidos, resumen: "Hecho." };
      }
      case "renombrar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a renombrar." };
        const nuevoNombre =
          typeof args.nuevo_nombre === "string" && args.nuevo_nombre.trim()
            ? args.nuevo_nombre
            : undefined;
        if (!nuevoNombre) return { error: "Falta indicar el nuevo nombre de la carpeta." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) {
          const comoArchivo = await resolverArchivo(usuarioId, hojaRuta(rutaArg));
          if (comoArchivo.archivo) {
            const r = await actualizarArchivo(comoArchivo.archivo.id, usuarioId, {
              nombre: nuevoNombre,
            });
            acciones.push(`Renombrado a "${r.nombre}"`);
            return { ok: true, nombre: r.nombre, resumen: "Hecho." };
          }
          if (comoArchivo.opciones)
            return registrarAclaracion(
              usuarioId,
              "renombrar_archivo",
              { nuevo_nombre: nuevoNombre },
              "nombre",
              comoArchivo.opciones,
              comoArchivo.sugerencia,
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones, res.sugerencia);
        const origen = res.ruta!;
        const destino = unirRuta(padreRuta(origen), nuevoNombre);
        const r = await moverCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta renombrada a ${destino}`);
        return { ok: true, destino, movidos: r.movidos, resumen: "Hecho." };
      }
      case "copiar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a copiar." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) {
          const comoArchivo = await resolverArchivo(usuarioId, hojaRuta(rutaArg));
          if (comoArchivo.archivo) {
            const r = await copiarArchivo(comoArchivo.archivo.id, usuarioId, {
              carpeta: typeof args.carpeta_destino === "string" ? args.carpeta_destino : undefined,
            });
            acciones.push(`Copiado "${r.nombre}"`);
            return { ok: true, nombre: r.nombre, resumen: "Hecho." };
          }
          if (comoArchivo.opciones)
            return registrarAclaracion(
              usuarioId,
              "copiar_archivo",
              { carpeta: typeof args.carpeta_destino === "string" ? args.carpeta_destino : undefined },
              "nombre",
              comoArchivo.opciones,
              comoArchivo.sugerencia,
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones, res.sugerencia);
        const origen = res.ruta!;
        const destino =
          typeof args.carpeta_destino === "string" && args.carpeta_destino
            ? unirRuta(normalizarRuta(args.carpeta_destino), hojaRuta(origen))
            : unirRuta(padreRuta(origen), `${hojaRuta(origen)} (copia)`);
        const r = await copiarCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta copiada a ${destino} (${r.copiados} archivo/s)`);
        return { ok: true, destino, copiados: r.copiados, resumen: "Hecho." };
      }
      // --- Leer / estadísticas ---
      case "leer_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        // Mismo criterio que el pre-flight de "abre/lee X": si todavía se está
        // indexando/escaneando en segundo plano, el texto puede no existir o
        // estar a medias — se avisa en vez de devolver eso.
        if (res.archivo!.estadoEscaneo === "pendiente" || res.archivo!.estadoEscaneo === "escaneando") {
          return { error: `"${res.archivo!.nombre}" todavía se está procesando. Inténtalo de nuevo en unos segundos.` };
        }
        // Si ya hay una factura escaneada en BD para este archivo, su resumen
        // (datos estructurados) es mucho más legible que el texto crudo de
        // OCR/pdf-parse.
        const factura = await obtenerFactura(usuarioId, res.archivo!.id, res.archivo!.nombre);
        if (factura.encontrada) return { ok: true, resumen: factura.resumen };
        const contenido = await leerTextoArchivo(res.archivo!.id, usuarioId);
        return { nombre: res.archivo!.nombre, contenido };
      }
      case "estadisticas": {
        const e = await estadisticasUsuario(usuarioId);
        const carpetas = await listarTodasCarpetas(usuarioId);
        return { ...e, numCarpetas: carpetas.length };
      }
      case "buscar_semantica": {
        const resultados = await buscarSemantica(usuarioId, String(args.consulta ?? ""));
        if (resultados.length === 0) {
          return { resultados: [], nota: "No se encontró nada relevante en el contenido." };
        }
        return {
          resultados: resultados.map((r) => ({
            nombre: r.nombre,
            carpeta: r.carpeta,
            fragmento: r.fragmento,
          })),
        };
      }
      case "escanear_todas_facturas": {
        // Busca todos los PDFs e imágenes. Se escanean de uno en uno (vía la
        // misma cola de extracción que usa la subida): el OCR/IA de visión es
        // pesado y escanearlos todos en paralelo competiría por la misma GPU.
        // No se relanza el OCR aquí (eso solo pasa al subir, vía encolarOcr):
        // si una imagen no tiene texto extraído es porque ya se intentó y no
        // encontró nada (o el usuario aún no la describió a mano).
        const todos = (await listarArchivos(usuarioId, undefined, 1, 200)).archivos;
        const facturas = todos.filter((a) =>
          /\.(pdf|jpg|jpeg|png|webp|tiff?)$/i.test(a.nombre) ||
          /^(application\/pdf|image\/)/.test(a.mimeType),
        );
        if (facturas.length === 0) return { ok: true, escaneadas: 0, nota: "No se encontraron facturas." };
        let ok = 0;
        let errores = 0;
        await Promise.all(
          facturas.map(async (a) => {
            // Igual que al subir: los PDFs (rápidos) adelantan a las imágenes
            // (OCR de visión, mucho más lento) que aún no hayan empezado.
            const prioridad = /^image\//.test(a.mimeType) ? PRIORIDAD_BAJA : PRIORIDAD_ALTA;
            try {
              await encolarExtraccion(() => escanearFactura(usuarioId, a.id), prioridad);
              ok++;
            } catch {
              errores++;
            }
          }),
        );
        acciones.push(`${ok} factura(s) escaneada(s)${errores ? `, ${errores} error(es)` : ""}`);
        return { ok: true, escaneadas: ok, errores };
      }
      case "obtener_factura": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        const r = await obtenerFactura(usuarioId, res.archivo!.id, res.archivo!.nombre);
        if (!r.encontrada) {
          return {
            error: `"${res.archivo!.nombre}" no tiene una factura escaneada. Primero escanéala con escanear_factura.`,
          };
        }
        return {
          ok: true,
          resumen: r.resumen,
          numero: r.numero,
          archivoId: res.archivo!.id,
          archivoNombre: res.archivo!.nombre,
        };
      }
      case "escanear_factura": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones, res.sugerencia);
        const pista = typeof args.pista === "string" ? args.pista : undefined;
        const r = await escanearFactura(usuarioId, res.archivo!.id, { pista });
        acciones.push(
          `Factura escaneada${r.numero ? ` (${r.numero})` : ""}: ${r.lineas} línea/s`,
        );
        return { ok: true, resumen: r.resumen, numero: r.numero, lineas: r.lineas };
      }
      case "ventas_top": {
        const { filtro, titulo } = filtroFacturasDesdeArgs(args);
        // Si nombra facturas concretas, escanea al vuelo las que aún no lo estén.
        if (filtro.facturas?.length) {
          const n = await asegurarFacturasEscaneadas(usuarioId, filtro.facturas);
          if (n > 0) acciones.push(`${n} factura(s) escaneada(s) automáticamente`);
        }
        const orden: "asc" | "desc" = args.orden === "menos" ? "asc" : "desc";
        const limite = typeof args.limite === "number" ? args.limite : 10;
        const top = await ventasTop(usuarioId, filtro, { orden, limite });
        const prefijo = orden === "asc" ? "Productos menos vendidos" : "Productos más vendidos";
        return { resumen: rankingMd(top, `${prefijo} (${titulo})`) };
      }
      case "totales_facturas": {
        const { filtro, titulo } = filtroFacturasDesdeArgs(args);
        if (filtro.facturas?.length) {
          const n = await asegurarFacturasEscaneadas(usuarioId, filtro.facturas);
          if (n > 0) acciones.push(`${n} factura(s) escaneada(s) automáticamente`);
        }
        const totales = await totalesFacturado(usuarioId, filtro);
        return { resumen: totalesMd(totales, `Totales facturados (${titulo})`) };
      }
      case "clientes_top": {
        const { filtro, titulo } = filtroFacturasDesdeArgs(args);
        const orden: "asc" | "desc" = args.orden === "menos" ? "asc" : "desc";
        const limite = typeof args.limite === "number" ? args.limite : 10;
        const top = await clientesTop(usuarioId, filtro, { orden, limite });
        const prefijo = orden === "asc" ? "Clientes que menos gastaron" : "Clientes que más gastaron";
        return { resumen: clientesTopMd(top, `${prefijo} (${titulo})`) };
      }
      default:
        return { error: `herramienta desconocida: ${nombre}` };
    }
  } catch (err) {
    const mensaje = err instanceof AppError ? err.message : "error al ejecutar la acción";
    return { error: mensaje };
  }
};

const NOMBRES_TOOLS = new Set(TOOLS.map((t) => t.function.name));

// El modelo a veces inventa nombres de tool con el patrón "<verbo>_factura"
// (ej. "mover_factura", "copiar_factura") en vez de usar las tools reales de
// archivo (una factura es un archivo normal). Se remapea al nombre real en
// vez de fallar la acción.
const remapearNombreTool = (nombre: string): string | undefined => {
  if (NOMBRES_TOOLS.has(nombre)) return nombre;
  const m = nombre.match(/^(copiar|mover|renombrar|eliminar|borrar)_facturas?$/);
  if (!m) return undefined;
  const verbo = m[1] === "borrar" ? "eliminar" : m[1];
  return `${verbo}_archivo`;
};

// Extrae todos los objetos JSON de nivel superior `{...}` de un texto, respetando
// el anidamiento y las comillas. Maneja varios objetos pegados o dentro de prosa.
const extraerObjetosJSON = (texto: string): string[] => {
  const objetos: string[] = [];
  let profundidad = 0;
  let inicio = -1;
  let enCadena = false;
  let escape = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (enCadena) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') enCadena = false;
      continue;
    }
    if (ch === '"') enCadena = true;
    else if (ch === "{") {
      if (profundidad === 0) inicio = i;
      profundidad++;
    } else if (ch === "}") {
      if (profundidad > 0) {
        profundidad--;
        if (profundidad === 0 && inicio >= 0) {
          objetos.push(texto.slice(inicio, i + 1));
          inicio = -1;
        }
      }
    }
  }
  return objetos;
};

// Algunos modelos (p.ej. qwen2.5-coder) a veces emiten las tool calls como
// texto JSON dentro de "content" en lugar de en el campo "tool_calls" (a veces
// varias seguidas). Esto las extrae como respaldo para poder ejecutarlas igual.
// Solo acepta objetos cuyo "name" sea una herramienta real (evita falsos positivos).
const extraerToolCallsDeTexto = (content: string): OllamaToolCall[] => {
  if (!content) return [];
  const calls: OllamaToolCall[] = [];
  for (const obj of extraerObjetosJSON(content)) {
    try {
      const parsed = JSON.parse(obj) as { name?: unknown; arguments?: unknown };
      const nombreReal = typeof parsed.name === "string" ? remapearNombreTool(parsed.name) : undefined;
      if (nombreReal) {
        calls.push({
          function: {
            name: nombreReal,
            arguments: (parsed.arguments as Record<string, unknown>) ?? {},
          },
        });
      }
    } catch {
      // No es JSON válido: lo ignoramos (es texto normal del asistente).
    }
  }
  return calls;
};

// Detecta si el texto parece un intento de tool call (objeto JSON con "name")
// que extraerToolCallsDeTexto descartó por no ser una herramienta real (el
// modelo se inventó un nombre, ej. "mover_factura"). Sirve para no mostrarle
// al usuario el JSON crudo como si fuera la respuesta del asistente.
const pareceIntentoToolCallInvalido = (content: string): boolean =>
  extraerObjetosJSON(content).some((obj) => {
    try {
      const parsed = JSON.parse(obj) as { name?: unknown };
      return typeof parsed.name === "string";
    } catch {
      return false;
    }
  });

// El modelo pequeño (7b/3b), ante una petición que no entiende, a veces no pide
// que se reformule sino que "responde" con la palabra suelta "error" (visto con
// mensajes ambiguos/sin sentido, ej. "haz una copia de desconecta la red"). Sin
// este filtro ese texto crudo se mostraba tal cual en el chat, pareciendo un
// fallo de la app en vez de una respuesta del bot.
const esRespuestaInutil = (content: string): boolean => /^error[.!]*$/i.test(content.trim());

// Tiempo máximo para UNA llamada a Ollama. Sin esto, una petición colgada
// (modelo cargándose, GPU ocupada, lo que sea) deja al usuario esperando
// indefinidamente sin respuesta ni error — "pensando" para siempre en vez de
// avisar de que algo falló. El bucle de herramientas hace varias llamadas por
// turno (hasta MAX_ITER), así que este límite es POR LLAMADA, no por turno
// completo.
const OLLAMA_TIMEOUT_MS = 45_000;

// Llama a Ollama /api/chat (sin streaming).
const llamarOllama = async (
  messages: OllamaMessage[],
  sinHerramientas = false,
): Promise<OllamaMessage> => {
  let res: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        ...(sinHerramientas ? {} : { tools: TOOLS }),
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError(
        504,
        "El asistente está tardando demasiado en responder. Inténtalo de nuevo en unos segundos.",
      );
    }
    throw new AppError(503, "El asistente no está disponible (no se puede conectar con Ollama).");
  } finally {
    clearTimeout(timeoutId);
  }

  const data = (await res.json()) as OllamaChatResponse;
  if (!res.ok || data.error) {
    const msg = data.error ?? `error ${res.status}`;
    if (/not found|no such model|pull/i.test(msg)) {
      throw new AppError(503, `Falta el modelo "${env.OLLAMA_MODEL}" en Ollama. Descárgalo con: ollama pull ${env.OLLAMA_MODEL}`);
    }
    throw new AppError(503, `El asistente falló: ${msg}`);
  }
  if (!data.message) throw new AppError(503, "Respuesta vacía del asistente.");
  return data.message;
};

// Filas por página de los listados paginados del chat (archivos y facturas). El
// frontend pide las páginas siguientes a los endpoints REST con este mismo límite.
const LISTADO_LIMITE = 20;

// Orquesta la conversación con el modelo y el bucle de herramientas.
export const chatear = async (
  usuarioId: string,
  mensajes: MensajeChat[],
): Promise<{
  respuesta: string;
  acciones: string[];
  archivos?: { id: string; nombre: string }[];
  // Las 3 tablas son paginadas con el MISMO patrón: la 1ª página viene aquí ya
  // resuelta; `filtro`/`carpeta` es lo que el frontend reenvía tal cual a un
  // endpoint REST normal (GET /api/archivos o GET /api/facturas) para pedir
  // más páginas sin pasar otra vez por el modelo. tablaCarpetas es la
  // excepción: manda TODAS las filas (las carpetas de un usuario son pocas en
  // la práctica) y el frontend pagina en memoria, sin más peticiones.
  tablaFacturas?: {
    titulo: string;
    pagina: number;
    totalPaginas: number;
    total: number;
    limite: number;
    filtro: Record<string, unknown>;
    filas: { archivoId: string | null; archivoNombre: string | null; fecha: string; total: number }[];
  };
  tablaArchivos?: {
    titulo: string;
    carpeta?: string;
    pagina: number;
    totalPaginas: number;
    total: number;
    limite: number;
    filas: { id: string; nombre: string; carpeta: string; tamanoBytes: string; subidoEn: Date }[];
  };
  tablaCarpetas?: {
    titulo: string;
    limite: number;
    filas: { ruta: string }[];
  };
  // Mismas opciones que el texto de mensajeAclaracion, pero en forma de tabla
  // clicable: el frontend pinta una fila por opción y, al pulsarla, manda
  // `valor` como si el usuario lo hubiera escrito (lo recoge el pre-flight de
  // aclaración pendiente de arriba). `limite` se manda por consistencia con
  // las otras tablas aunque aquí no haya paginación contra el servidor.
  tablaAclaracion?: {
    titulo: string;
    sugerencia: boolean;
    limite: number;
    filas: { etiqueta: string; valor: string; archivoId?: string }[];
  };
}> => {
  // Solo el último mensaje del usuario. En un asistente de archivos cada orden es
  // independiente; enviar el historial hace que modelos pequeños re-ejecuten
  // acciones de turnos anteriores (p.ej. repetir un "borrar_todo"), lo cual es
  // peligroso. Si en el futuro se quieren follow-ups, reintroducir contexto acotado.
  const ultimo = mensajes[mensajes.length - 1];
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: ultimo.rol === "usuario" ? "user" : "assistant",
      content: ultimo.contenido,
    },
  ];

  const acciones: string[] = [];
  // Si una tool resuelve uno o varios archivos concretos (ej. obtener_factura,
  // buscar_archivos), se guardan aquí para que el front pueda ofrecer botones
  // "Abrir archivo" (abrir una pestaña nueva desde el chat sin botón propio
  // choca con el bloqueo de pop-ups del navegador).
  let archivosParaAbrir: { id: string; nombre: string }[] = [];

  // Pre-flight: el modelo no siempre llama de forma fiable a "borrar_todo" /
  // "borrar_todas_carpetas" / "borrar_todos_archivos" para frases muy directas,
  // así que se detectan aquí. Distingue "borra TODO" (incluida la raíz) de
  // "borra todas las carpetas" (carpetas + su contenido, raíz intacta) de
  // "borra todos los archivos/ficheros" (archivos, carpetas intactas).
  const ultimoMensaje = mensajes[mensajes.length - 1]?.contenido ?? "";
  const msgLower = ultimoMensaje.toLowerCase();
  // Sin tildes, para los pre-flights de verbos de acción: así "bórralo todo" /
  // "elimínalo" / "vacíalas" casan igual que "borra todo" / "elimina" / "vacia".
  const msgSinTildes = quitarTildes(msgLower);
  // Patrones de verbo reutilizados por los pre-flights de borrado/restaurar:
  // admiten el pronombre enclítico pegado ("bórralo", "elimínala", "sácalos")
  // ya que sin él "borra"/"elimina" no aparecen como palabra completa dentro
  // de "borralo"/"eliminala" (no hay límite de palabra ahí para \b).
  const VERBO_BORRAR = "(?:borra(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)";
  const VERBO_RESTAURAR = "(?:restaura(?:r|lo|la|los|las)?|recupera(?:r|lo|la|los|las)?|saca(?:r|lo|la|los|las)?)";
  // Mismo tratamiento (pronombre enclítico + sin tildes) para el resto de
  // verbos de acción usados en los pre-flights de abrir/mostrar, buscar,
  // crear, listar, y las listas de exclusión de otras acciones (mover/copiar/
  // renombrar/escanear) que antes solo reconocían la forma sin pronombre.
  const VERBO_ABRIR =
    "(?:abre(?:lo|la|los|las)?|abrir|muestra(?:me)?(?:lo|la|los|las)?|ensena(?:me)?(?:lo|la|los|las)?)";
  const VERBO_BUSCAR = "(?:busca(?:r|lo|la|los|las)?)";
  const VERBO_CREAR = "(?:crea(?:me)?(?:lo|la|los|las)?)";
  const VERBO_LISTAR =
    "(?:pasa(?:me)?(?:lo|la|los|las)?|dame|envia(?:me)?(?:lo|la|los|las)?|muestra(?:me)?(?:lo|la|los|las)?|ensena(?:me)?(?:lo|la|los|las)?|lista(?:r|lo|la|los|las)?)";
  const VERBO_OTRAS_ACCIONES =
    "mueve(?:lo|la|los|las)?|mover|copia(?:lo|la|los|las)?|copiar|renombra(?:lo|la|los|las)?|cambia(?:lo|la|los|las)?|escane[ao](?:lo|la|los|las)?";

  // Palabras sueltas que NO deben tratarse como nombre de archivo si aparecen
  // justo tras un verbo de acción (ej. "borra mi reporte", "muestra todo lo
  // que tengo" — "todo" aquí no es un nombre de archivo, es "todo lo que
  // tengo", y debe caer en el pre-flight de listado en vez de en estos).
  const STOPWORDS_NOMBRE = new Set([
    "mi", "tu", "su", "lo", "la", "el", "los", "las", "eso", "esto", "esta",
    "este", "todo", "toda", "algo", "uno", "una", "ese", "esa",
  ]);

  // Detecta un mes (por nombre) y/o año (4 dígitos) en el mensaje, para los
  // pre-flights de periodo de facturas (ranking de ventas, listado de facturas).
  const MESES: Record<string, number> = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
    noviembre: 11, diciembre: 12,
  };
  const detectarMesAnio = (texto: string): { mes?: number; anio?: number } => {
    let mes: number | undefined;
    for (const [nombreMes, num] of Object.entries(MESES)) {
      if (new RegExp(`\\b${nombreMes}\\b`).test(texto)) {
        mes = num;
        break;
      }
    }
    const anioMatch = texto.match(/\b(20\d{2})\b/);
    let anio = anioMatch ? Number(anioMatch[1]) : undefined;

    // Periodos relativos ("este mes", "el mes pasado", "este año", "el año
    // pasado"): solo si no se detectó ya un mes/año explícito (un nombre de
    // mes o un año de 4 dígitos siempre tiene prioridad sobre estos). `texto`
    // ya viene sin tildes (quitarTildes convierte "año" -> "ano").
    if (mes === undefined && anio === undefined) {
      const ahora = new Date();
      if (/\bmes\s+pasado\b/.test(texto) || /\bel\s+mes\s+anterior\b/.test(texto)) {
        const fecha = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
        mes = fecha.getMonth() + 1;
        anio = fecha.getFullYear();
      } else if (/\b(este|el)\s+mes\b/.test(texto) || /\bmes\s+actual\b/.test(texto)) {
        mes = ahora.getMonth() + 1;
        anio = ahora.getFullYear();
      } else if (/\bano\s+pasado\b/.test(texto) || /\bel\s+ano\s+anterior\b/.test(texto)) {
        anio = ahora.getFullYear() - 1;
      } else if (/\b(este|el)\s+ano\b/.test(texto) || /\bano\s+actual\b/.test(texto)) {
        anio = ahora.getFullYear();
      }
    }
    return { mes, anio };
  };

  // Pre-flight: si en el turno anterior se pidió aclarar entre varias
  // coincidencias y este mensaje es justo la opción elegida (el usuario copia/
  // escribe el nombre que se le ofreció), se completa AQUÍ la acción original
  // (tool + argumentos de entonces) en vez de tratarlo como un mensaje nuevo
  // sin contexto. Si no coincide con ninguna opción, se descarta para no
  // aplicar un estado obsoleto a una petición distinta.
  const pendiente = pendientesAclaracion.get(usuarioId);
  if (pendiente) {
    pendientesAclaracion.delete(usuarioId);
    if (Date.now() - pendiente.ts < TTL_ACLARACION_MS) {
      const normalizado = ultimoMensaje.trim().replace(/^[-•]\s*/, "").toLowerCase();
      // Si el usuario rechaza la aclaración ("no", "ninguna", "cancela"...) hay
      // que responder algo claro aquí mismo: como ya se borró el pendiente y
      // "no" no es un mensaje con contenido propio, dejarlo caer al flujo
      // normal mandaba "no" suelto al modelo (pequeño) y este devolvía "{}".
      const esNegacion =
        /^(?:no|nope|nah)(?:\s+(?:gracias|por\s+ahora|era\s+es[ao]|es\s+es[ao]|quiero|asi))?[.,!¡]*$|^ninguna?(?:\s+de\s+(?:esas|estas|ellas))?[.,!¡]*$|^(?:cancela(?:r|lo)?|olvidalo|dejalo|mejor\s+no|para\s+nada)[.,!¡]*$/
          .test(quitarTildes(normalizado));
      if (esNegacion) {
        return { respuesta: "Vale, lo dejo así. Dime si quieres que busque otra cosa.", acciones };
      }
      // Si solo se ofreció UNA opción, un "sí"/"vale"/"ok" también la confirma
      // (no hace falta que el usuario repita el nombre completo).
      const esAfirmacion =
        pendiente.opciones.length === 1 &&
        /^(?:si|si\s+por\s+favor|vale|ok(?:ay)?|dale|claro|correcto|exacto|afirmativo)[.,!¡]*$/.test(
          quitarTildes(normalizado),
        );
      const candidatos = esAfirmacion
        ? pendiente.opciones
        : pendiente.opciones.filter((o) => {
            const texto = (typeof o === "string" ? o : o.nombre).toLowerCase();
            return normalizado === texto || normalizado.includes(texto);
          });
      if (candidatos.length === 1) {
        const elegido = candidatos[0];
        const valor = typeof elegido === "string" ? elegido : elegido.nombre;
        const argsFinal = { ...pendiente.args, [pendiente.clave]: valor };
        const resultado = (await ejecutarTool(
          pendiente.tool,
          argsFinal,
          usuarioId,
          acciones,
        )) as Record<string, unknown>;
        if (resultado.necesita_aclaracion === true && Array.isArray(resultado.opciones)) {
          return respuestaAclaracion(
            resultado.opciones as OpcionAclaracion[],
            resultado.sugerencia === true,
            acciones,
            pendiente.tool,
          );
        }
        if (typeof resultado.error === "string") return { respuesta: resultado.error, acciones };
        if (typeof resultado.resumen === "string") {
          return {
            respuesta: resultado.resumen,
            acciones,
            archivos:
              typeof resultado.archivoId === "string" && typeof resultado.archivoNombre === "string"
                ? [{ id: resultado.archivoId, nombre: resultado.archivoNombre }]
                : undefined,
          };
        }
        // leer_archivo (sin factura escaneada) no devuelve "resumen" sino
        // {nombre, contenido} directo: hay que formatearlo aquí igual que el
        // resto de rutas de lectura, o se perdía el contenido y solo se veía "Hecho.".
        if (typeof resultado.contenido === "string" && typeof resultado.nombre === "string") {
          return {
            respuesta: `**${resultado.nombre}**:\n\n${resultado.contenido}`,
            acciones,
          };
        }
        return { respuesta: "Hecho.", acciones };
      }
    }
  }

  // Pre-flight: COMANDOS COMPUESTOS ("ábreme X y Y", "crea X y copia Y y borra Z").
  // Los pre-flights de abajo resuelven UNA sola acción y hacen return en cuanto
  // casan, así que un mensaje con varias órdenes encadenadas solo ejecutaba la
  // primera (o caía al modelo, que con varias acciones encadena mal). Aquí se
  // parte el mensaje por conectores (" y ", comas, "luego", "además"...), se
  // parsea cada segmento a una acción y se ejecutan TODAS en orden.
  //
  // Es opt-in y conservador: solo intercepta si hay 2+ segmentos que parsean a
  // una acción clara Y todos sus objetivos resuelven (validación en modo
  // solo-lectura ANTES de ejecutar nada). Si algo no resuelve -p.ej. "muéstrame
  // las facturas de enero y febrero", donde "las facturas de enero" no es un
  // archivo-, NO intercepta y deja pasar al flujo normal de abajo (que sí lo
  // maneja). Así un comando simple (1 solo segmento) o un listado nunca se ven
  // afectados.
  type AccionCompuesta =
    | { tipo: "abrir"; nombre: string }
    | { tipo: "tool"; tool: string; args: Record<string, unknown>; verbo: "eliminar" | "otro" };

  // Limpia un nombre capturado: comillas, puntuación final, artículo inicial.
  const limpiarNombreComp = (s: string): string =>
    s
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .replace(/[?¿.!¡]+$/g, "")
      .replace(/^(?:el|la|los|las|un|una|mi|mis)\s+/i, "")
      .trim();
  // Limpia un destino ("a la carpeta X", "en X", "dentro de X") -> "X".
  const limpiarDestinoComp = (s: string): string =>
    limpiarNombreComp(
      s
        .trim()
        .replace(/^(?:a|al|en|hacia|dentro\s+de)\s+/i, "")
        .replace(/^(?:la\s+|el\s+)?carpeta\s+/i, ""),
    );

  // Parte el mensaje por conectores. Trabaja sobre la versión sin tildes para
  // reconocer "luego/después/además" acentuados, pero corta el original-lower
  // (misma longitud) para conservar tildes en los nombres.
  const dividirSegmentos = (textoLower: string): string[] => {
    const sin = quitarTildes(textoLower);
    const re =
      /\s+y\s+luego\s+|\s+y\s+despues\s+|\s+y\s+tambien\s+|\s+y\s+ademas\s+|\s+y\s+|\s+luego\s+|\s+despues\s+|\s+ademas\s+|\s+tambien\s+|\s*[,;]\s*/g;
    const segmentos: string[] = [];
    let ultimo = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sin)) !== null) {
      segmentos.push(textoLower.slice(ultimo, m.index));
      ultimo = m.index + m[0].length;
    }
    segmentos.push(textoLower.slice(ultimo));
    return segmentos.map((s) => s.trim()).filter(Boolean);
  };

  // Parsea un segmento a una acción. `ctx.ultimaCarpeta` es la última carpeta
  // creada/mencionada en segmentos anteriores, para resolver destinos implícitos
  // ("...y mueve X ahí"). Devuelve la acción, "carry" (no tiene verbo: es un
  // objeto suelto del verbo anterior, p.ej. la "Y" de "abre X y Y"), o null (no
  // es una acción reconocible -> aborta el modo compuesto).
  const parsearSegmento = (
    seg: string,
    ctx: { ultimaCarpeta?: string },
  ): AccionCompuesta | "carry" | null => {
    const sin = quitarTildes(seg);
    let m: RegExpMatchArray | null;
    const okNombre = (n: string): boolean =>
      !!n && !STOPWORDS_NOMBRE.has(quitarTildes(n.toLowerCase())) &&
      !/^(todo|todos|todas)\b/.test(quitarTildes(n.toLowerCase()));

    // mover X ahí / allí / a esa carpeta -> destino = última carpeta del mensaje
    if (
      ctx.ultimaCarpeta &&
      (m = sin.match(/^(?:mueve(?:lo|la|los|las)?|mover|traslada(?:r|lo|la|los|las)?)\s+(.+?)\s+(?:ahi|alli|alla|aca|aqui|a\s+esa\s+carpeta|a\s+esa|a\s+la\s+carpeta)$/))
    ) {
      const nombre = limpiarNombreComp(grupoOriginal(seg, m, 1));
      if (okNombre(nombre)) return { tipo: "tool", tool: "mover_archivo", args: { nombre, carpeta: ctx.ultimaCarpeta }, verbo: "otro" };
    }
    // mover X a Y
    if ((m = sin.match(/^(?:mueve(?:lo|la|los|las)?|mover|traslada(?:r|lo|la|los|las)?)\s+(.+?)\s+(?:a|al|en|hacia|dentro\s+de)\s+(.+)$/))) {
      const nombre = limpiarNombreComp(grupoOriginal(seg, m, 1));
      const carpeta = limpiarDestinoComp(grupoOriginal(seg, m, 2));
      if (okNombre(nombre) && carpeta) return { tipo: "tool", tool: "mover_archivo", args: { nombre, carpeta }, verbo: "otro" };
    }
    // renombrar X a/como/por Y
    if ((m = sin.match(/^(?:renombra(?:lo|la|los|las)?|renombrar)\s+(.+?)\s+(?:a|como|por)\s+(.+)$/))) {
      const nombre = limpiarNombreComp(grupoOriginal(seg, m, 1));
      const nuevo = limpiarNombreComp(grupoOriginal(seg, m, 2));
      if (okNombre(nombre) && nuevo) return { tipo: "tool", tool: "renombrar_archivo", args: { nombre, nuevo_nombre: nuevo }, verbo: "otro" };
    }
    // copiar X ahí / a esa carpeta -> destino = última carpeta del mensaje
    if (
      ctx.ultimaCarpeta &&
      (m = sin.match(/^(?:copia(?:lo|la|los|las)?|copiar|duplica(?:r|lo|la|los|las)?)\s+(.+?)\s+(?:ahi|alli|alla|aca|aqui|a\s+esa\s+carpeta|a\s+esa|a\s+la\s+carpeta)$/))
    ) {
      const nombre = limpiarNombreComp(grupoOriginal(seg, m, 1));
      if (okNombre(nombre)) return { tipo: "tool", tool: "copiar_archivo", args: { nombre, carpeta: ctx.ultimaCarpeta }, verbo: "otro" };
    }
    // copiar X [a Y]
    if ((m = sin.match(/^(?:copia(?:lo|la|los|las)?|copiar|duplica(?:r|lo|la|los|las)?)\s+(.+?)(?:\s+(?:a|al|en|hacia|dentro\s+de)\s+(.+))?$/))) {
      const nombre = limpiarNombreComp(grupoOriginal(seg, m, 1));
      const carpeta = m[2] ? limpiarDestinoComp(grupoOriginal(seg, m, 2)) : undefined;
      if (okNombre(nombre)) return { tipo: "tool", tool: "copiar_archivo", args: { nombre, ...(carpeta ? { carpeta } : {}) }, verbo: "otro" };
    }
    // crear carpeta X (antes que "crear nota/archivo")
    if ((m = sin.match(/^(?:crea(?:me)?(?:lo|la|los|las)?|crear)\s+(?:la\s+|una\s+)?carpeta\s+(?:llamad[oa]\s+)?(.+)$/))) {
      const ruta = limpiarNombreComp(grupoOriginal(seg, m, 1));
      if (ruta) return { tipo: "tool", tool: "crear_carpeta", args: { ruta }, verbo: "otro" };
    }
    // crear nota/archivo/documento X [con: ...]
    if ((m = sin.match(/^(?:crea(?:me)?(?:lo|la|los|las)?|crear)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:nota|archivo|documento|fichero)\s+(?:llamad[oa]\s+)?(.+)$/))) {
      const resto = grupoOriginal(seg, m, 1);
      const conContenido = resto.match(/^(.+?)\s+(?:con\s+esto|con\s+el\s+contenido|con\s+texto|que\s+diga|que\s+ponga|con)\s*:?\s*([\s\S]+)$/i);
      let nombre = limpiarNombreComp(conContenido ? conContenido[1] : resto);
      const contenido = conContenido ? conContenido[2].trim() : "";
      if (nombre && !/\.(md|txt)$/i.test(nombre)) nombre = `${nombre}.md`;
      if (nombre) return { tipo: "tool", tool: "crear_archivo", args: { nombre, contenido }, verbo: "otro" };
    }
    // borrar/eliminar X (archivo o carpeta)
    if ((m = sin.match(/^(?:borra(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)\s+(.+)$/))) {
      const esCarpeta = /\bcarpeta\b/.test(sin);
      const crudo = grupoOriginal(seg, m, 1).replace(
        /^(?:el\s+archivo\s+|la\s+nota\s+|el\s+documento\s+|el\s+fichero\s+|la\s+carpeta\s+)/i,
        "",
      );
      const nombre = limpiarNombreComp(crudo);
      if (okNombre(nombre))
        return { tipo: "tool", tool: esCarpeta ? "eliminar_carpeta" : "eliminar_archivo", args: { nombre, ruta: nombre }, verbo: "eliminar" };
      return null; // "borra todo" y similares -> no es comando compuesto
    }
    // abrir/leer/mostrar X
    if ((m = sin.match(/^(?:abre(?:me)?(?:lo|la|los|las)?|abrir|lee(?:me)?|muestra(?:me)?(?:lo|la|los|las)?|ensena(?:me)?(?:lo|la|los|las)?|que\s+dice)\s+(.+)$/))) {
      const crudo = grupoOriginal(seg, m, 1).replace(
        /^(?:el\s+archivo\s+|la\s+nota\s+|el\s+documento\s+|el\s+fichero\s+)/i,
        "",
      );
      const nombre = limpiarNombreComp(crudo);
      if (okNombre(nombre)) return { tipo: "abrir", nombre };
      return null;
    }
    return "carry";
  };

  const segmentos = dividirSegmentos(msgLower);
  if (segmentos.length >= 2 && segmentos.length <= 8) {
    const acciones2: AccionCompuesta[] = [];
    let ultimoVerbo: "abrir" | "eliminar" | null = null;
    const ctx: { ultimaCarpeta?: string } = {};
    let parseOk = true;
    for (const seg of segmentos) {
      const p = parsearSegmento(seg, ctx);
      if (p === "carry") {
        // Objeto suelto: hereda el verbo anterior (solo abrir/eliminar, los que
        // se reparten de forma natural: "abre X y Y", "borra A, B y C").
        const nombre = limpiarNombreComp(seg);
        const ok = !!nombre && !STOPWORDS_NOMBRE.has(quitarTildes(nombre.toLowerCase()));
        if (ultimoVerbo === "abrir" && ok) acciones2.push({ tipo: "abrir", nombre });
        else if (ultimoVerbo === "eliminar" && ok && !/^(todo|todos|todas)\b/.test(quitarTildes(nombre.toLowerCase())))
          acciones2.push({ tipo: "tool", tool: "eliminar_archivo", args: { nombre, ruta: nombre }, verbo: "eliminar" });
        else { parseOk = false; break; }
      } else if (p) {
        acciones2.push(p);
        ultimoVerbo = p.tipo === "abrir" ? "abrir" : p.verbo === "eliminar" ? "eliminar" : null;
        // Recuerda la última carpeta creada/usada como destino, para resolver
        // "...y mueve X ahí" en un segmento posterior.
        if (p.tipo === "tool") {
          if (p.tool === "crear_carpeta") ctx.ultimaCarpeta = String(p.args.ruta);
          else if ((p.tool === "mover_archivo" || p.tool === "copiar_archivo") && typeof p.args.carpeta === "string")
            ctx.ultimaCarpeta = p.args.carpeta;
        }
      } else {
        parseOk = false;
        break;
      }
    }

    if (parseOk && acciones2.length >= 2) {
      // ¿Ejecutar el modo compuesto? Un compuesto formado SOLO por "abrir/leer"
      // se solapa con consultas que NO son comandos ("muéstrame las facturas de
      // enero y febrero"): para esos exigimos que TODOS los objetivos resuelvan;
      // si alguno no, se abandona el modo compuesto y se deja pasar al flujo
      // normal de abajo (que sí maneja esas consultas). En cambio, si hay alguna
      // acción de crear/mover/copiar/borrar/renombrar (cualquier `tipo: "tool"`),
      // la intención de comando es inequívoca: se ejecuta SIEMPRE, best-effort
      // (cada parte por su cuenta, avisando de la que falle) en vez de caer al
      // modelo, que dejaría el trabajo a medias y confuso.
      const soloAbrir = acciones2.every((a) => a.tipo === "abrir");
      let ejecutar = true;
      if (soloAbrir) {
        for (const a of acciones2) {
          const res = await resolverArchivo(usuarioId, (a as { nombre: string }).nombre);
          if (!res.archivo) { ejecutar = false; break; }
        }
      }

      if (ejecutar) {
        const lecturas: string[] = [];
        for (const a of acciones2) {
          if (a.tipo === "abrir") {
            const res = await resolverArchivo(usuarioId, a.nombre);
            if (res.opciones) {
              // Nombre con errata: se ofrecen sugerencias y se corta aquí (la
              // aclaración queda registrada para completarla cuando el usuario
              // elija). Lo ya hecho en segmentos anteriores se conserva en `acciones`.
              registrarAclaracion(usuarioId, "leer_archivo", {}, "nombre", res.opciones, res.sugerencia);
              const previo = lecturas.length ? `${lecturas.join("\n\n---\n\n")}\n\n---\n\n` : "";
              return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "leer_archivo", {
                previo,
                archivos: archivosParaAbrir.length ? archivosParaAbrir : undefined,
              });
            }
            if (!res.archivo) {
              lecturas.push(`⚠️ ${res.error ?? `No encontré ningún archivo que coincida con "${a.nombre}".`}`);
              continue;
            }
            const archivo = res.archivo;
            archivosParaAbrir.push({ id: archivo.id, nombre: archivo.nombre });
            if (archivo.estadoEscaneo === "pendiente" || archivo.estadoEscaneo === "escaneando") {
              lecturas.push(`**${archivo.nombre}**: todavía se está procesando, inténtalo en unos segundos.`);
              continue;
            }
            const factura = await obtenerFactura(usuarioId, archivo.id, archivo.nombre);
            if (factura.encontrada) { lecturas.push(factura.resumen!); continue; }
            try {
              const contenido = await leerTextoArchivo(archivo.id, usuarioId);
              lecturas.push(`**${archivo.nombre}**:\n\n${contenido}`);
            } catch (err) {
              lecturas.push(`**${archivo.nombre}**: ${err instanceof AppError ? err.message : "no pude leer el contenido."}`);
            }
          } else {
            const r = (await ejecutarTool(a.tool, a.args, usuarioId, acciones)) as Record<string, unknown>;
            if (r.necesita_aclaracion === true && Array.isArray(r.opciones)) {
              // Nombre con errata en una acción (mover/copiar/borrar...): ejecutarTool
              // ya dejó registrada la aclaración con sus args (incl. destino), así
              // que basta cortar aquí mostrando las sugerencias; al elegir, se
              // completa la acción original. Lo ya hecho se conserva en `acciones`.
              const previo = lecturas.length ? `${lecturas.join("\n\n---\n\n")}\n\n---\n\n` : "";
              return respuestaAclaracion(r.opciones as OpcionAclaracion[], r.sugerencia === true, acciones, a.tool, {
                previo,
                archivos: archivosParaAbrir.length ? archivosParaAbrir : undefined,
              });
            }
            if (typeof r.error === "string") lecturas.push(`⚠️ ${r.error}`);
          }
        }
        return {
          respuesta: lecturas.length ? lecturas.join("\n\n---\n\n") : "Hecho.",
          acciones,
          archivos: archivosParaAbrir.length ? archivosParaAbrir : undefined,
        };
      }
    }
  }

  // Pre-flight: "restaura/recupera todos los archivos/ficheros" (recuperar TODA
  // la papelera de una vez). Sin este pre-flight, el modelo no tiene ninguna tool
  // de "restaurar todo" entre las que conoce y puede "resolver" la frase con la
  // única tool masiva de papelera que sí existía -vaciar_papelera- (se vio
  // exactamente esto: "restaura todos los ficheros" acabó vaciando la papelera,
  // justo la acción opuesta -borrado DEFINITIVO- a la pedida). Se resuelve aquí
  // sin pasar por el modelo, igual que el resto de borrados/restauraciones masivas.
  const esRestaurarTodo =
    new RegExp(`\\b${VERBO_RESTAURAR}\\b\\s+todo\\b`).test(msgSinTildes) ||
    new RegExp(
      `\\b${VERBO_RESTAURAR}\\b\\s+(?:todos?|todas?)\\s+(?:el\\s+|la\\s+|los\\s+|las\\s+)?(?:archivos?|ficheros?|papelera)\\b`,
    ).test(msgSinTildes);
  if (esRestaurarTodo) {
    const r = await restaurarTodo(usuarioId);
    acciones.push(`Restaurados ${r.restaurados} archivo/s de la papelera.`);
    return { respuesta: "Hecho.", acciones };
  }

  // Pre-flight: "facturas de/en la papelera" es más específico que el listado
  // general de la papelera de abajo — lista solo las FACTURAS que están en la
  // papelera (con botón "Abrir" cuando aplica), no todos los archivos. Se
  // comprueba ANTES del listado general para que tenga prioridad cuando se
  // menciona "factura(s)".
  const esListarFacturasPapelera =
    /\bfacturas?\b/.test(msgSinTildes) &&
    /papelera/.test(msgSinTildes) &&
    !/borra|elimina|restaura|recupera|vacia/.test(msgSinTildes);
  if (esListarFacturasPapelera) {
    const { filas, total, paginas } = await listarFacturasPapelera(usuarioId, { pagina: 1, limite: 20 });
    const titulo = "Facturas en la papelera";
    if (filas.length === 0) return { respuesta: "No hay facturas en la papelera.", acciones };
    return {
      respuesta: listadoFacturasMd(filas, titulo),
      acciones,
      tablaFacturas: {
        titulo,
        pagina: 1,
        totalPaginas: paginas,
        total,
        limite: 20,
        filtro: { papelera: true },
        // archivoId a null: un archivo en la papelera no se puede abrir con el
        // flujo normal (descargarArchivo/obtenerArchivo excluyen lo borrado),
        // así que se omite el botón "Abrir" en vez de ofrecer uno roto.
        filas: filas.map((f) => ({
          archivoId: null,
          archivoNombre: f.archivoNombre,
          fecha: formatearFecha(f.fecha),
          total: f.total,
        })),
      },
    };
  }

  // Pre-flight: "¿qué hay en la papelera?" es una consulta directa y frecuente
  // que el modelo a veces desvía hacia herramientas de facturas (el prompt de
  // facturas es grande y le hace sesgo), devolviendo contenido random no
  // relacionado. Se resuelve aquí sin pasar por el modelo. Se excluye si
  // menciona "factura(s)" (eso ya lo captura el pre-flight más específico de
  // arriba).
  const esListarPapelera =
    /papelera/.test(msgLower) &&
    /(qu[eé]\s+hay|lista(r)?|dame|mu[eé]stra(me)?|ense[ñn]a(me)?|p[aá]sa(me)?|ver)/.test(msgLower) &&
    !/borra|elimina|restaura|recupera|vacia/.test(msgSinTildes) &&
    !/\bfacturas?\b/.test(msgSinTildes);
  if (esListarPapelera) {
    const lista = await listarPapelera(usuarioId);
    if (lista.length === 0) return { respuesta: "La papelera está vacía.", acciones };
    const detalle = lista.map((a) => `- ${a.nombre}${a.carpeta !== "/" ? ` (${a.carpeta})` : ""}`).join("\n");
    return { respuesta: `En la papelera tienes ${lista.length} archivo(s):\n\n${detalle}`, acciones };
  }

  // Pre-flight: "restaura/recupera/saca X de la papelera" (recuperar) vs "borra/
  // elimina X de la papelera" (borrado DEFINITIVO) son acciones opuestas que el
  // modelo confunde a pesar de la instrucción explícita del prompt sobre esto
  // -se ha visto "borra X de la papelera" ejecutar un restaurar_archivo, justo
  // lo contrario de lo pedido-, así que se resuelven aquí de forma determinista.
  if (/papelera/.test(msgSinTildes)) {
    const tieneIntencionRestaurar = new RegExp(`\\b${VERBO_RESTAURAR}\\b`).test(msgSinTildes);
    const tieneIntencionBorrarDef = new RegExp(`\\b${VERBO_BORRAR}\\b`).test(msgSinTildes);
    const matchNombrePapelera = msgSinTildes.match(
      new RegExp(`\\b(?:${VERBO_RESTAURAR}|${VERBO_BORRAR})\\b\\s+(?:el\\s+archivo\\s+)?["']?([\\wÀ-ÿ.-]+)`),
    );
    if (matchNombrePapelera && (tieneIntencionRestaurar || tieneIntencionBorrarDef)) {
      const res = await resolverEnPapelera(usuarioId, grupoOriginal(msgLower, matchNombrePapelera));
      if (res.error) return { respuesta: res.error, acciones };
      if (res.opciones) {
        const tool = tieneIntencionRestaurar ? "restaurar_archivo" : "borrar_permanente";
        registrarAclaracion(usuarioId, tool, {}, "nombre", res.opciones);
        return respuestaAclaracion(res.opciones, undefined, acciones, tool);
      }
      if (tieneIntencionRestaurar) {
        await restaurarArchivo(res.archivo!.id, usuarioId);
        acciones.push(`Restaurado "${res.archivo!.nombre}"`);
      } else {
        await borrarPermanente(res.archivo!.id, usuarioId);
        acciones.push(`Borrado definitivamente "${res.archivo!.nombre}"`);
      }
      return { respuesta: "Hecho.", acciones };
    }
  }

  // Pre-flight: "abre/muéstrame factura_X" debe leer la factura YA escaneada
  // de la BD (instantáneo). Si se deja en manos del modelo, a veces interpreta
  // "abrir" como "voy a procesarla yo" y dispara un re-escaneo con OCR (lento,
  // y si la factura nunca se había escaneado, parece que la petición "no
  // funciona" cuando en realidad solo está tardando mucho). Se resuelve aquí
  // sin pasar por Ollama; si no está escaneada, se dice al instante en vez de
  // escanearla sin que el usuario lo pidiera.
  const tieneIntencionAbrirFactura = new RegExp(`\\b${VERBO_ABRIR}\\b`).test(msgSinTildes);
  // OJO: el sufijo es OBLIGATORIO (dígito/_/- justo tras "factura(s)", no
  // cualquier letra) por DOS razones: 1) sin él, "facturajpg.jpg" (un archivo
  // cualquiera que solo tiene la mala suerte de empezar por "factura") se
  // tragaba entero como nombre de factura, y al no tener fila en la tabla
  // Factura se le decía "escanéala primero" en vez de simplemente abrirlo
  // como el archivo normal que es; 2) sin él, "muéstrame las facturas de este
  // año" (un LISTADO, sin ningún identificador concreto) también casaba aquí
  // -"muestra" es VERBO_ABRIR- e intentaba abrir un archivo literal llamado
  // "facturas", que no existe, en vez de caer en el pre-flight de listado de
  // más abajo (que sí lo resuelve bien). "Pásame" no es VERBO_ABRIR, por eso
  // con ese verbo sí funcionaba y con "muéstrame" no.
  const matchNombreFactura = msgLower.match(/\bfacturas?[\d_-]\w*\b/);
  const esAbrirFactura =
    tieneIntencionAbrirFactura &&
    !!matchNombreFactura &&
    !new RegExp(VERBO_BORRAR + "|" + VERBO_OTRAS_ACCIONES).test(msgSinTildes);
  if (esAbrirFactura && matchNombreFactura) {
    const res = await resolverArchivo(usuarioId, matchNombreFactura[0]);
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "obtener_factura", {}, "nombre", res.opciones, res.sugerencia);
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "obtener_factura");
    }
    if (res.archivo!.estadoEscaneo === "pendiente" || res.archivo!.estadoEscaneo === "escaneando") {
      return {
        respuesta: `"${res.archivo!.nombre}" todavía se está escaneando. Inténtalo de nuevo en unos segundos.`,
        acciones,
        archivos: [{ id: res.archivo!.id, nombre: res.archivo!.nombre }],
      };
    }
    const r = await obtenerFactura(usuarioId, res.archivo!.id, res.archivo!.nombre);
    if (!r.encontrada) {
      return {
        respuesta: `"${res.archivo!.nombre}" no tiene una factura escaneada todavía. Pide "escanea ${res.archivo!.nombre}" primero.`,
        acciones,
      };
    }
    return {
      respuesta: r.resumen!,
      acciones,
      archivos: [{ id: res.archivo!.id, nombre: res.archivo!.nombre }],
    };
  }

  // Extrae "de [cliente/la empresa] X" al final del mensaje como nombre de
  // cliente, para filtrar totales_facturas/ventas_top cuando el mensaje no es
  // un periodo. El ".*" inicial (codicioso) hace que, si hay varias "de" en
  // el mensaje, se quede con la ÚLTIMA (la más cercana al nombre real).
  // Descarta capturas que claramente no son un nombre de cliente (periodo
  // relativo, "la carpeta X", "la papelera", palabras sueltas sin valor).
  const extraerClienteDeFrase = (texto: string, original: string): string | null => {
    const m = texto.match(
      /.*\b(?:del\s+cliente\s+|de\s+el\s+cliente\s+|de\s+cliente\s+|del\s+|de\s+la\s+empresa\s+|de\s+)(.+?)[?¿.!¡]*$/,
    );
    if (!m) return null;
    const cliente = grupoOriginal(original, m).trim();
    const clienteSinTildes = quitarTildes(cliente.toLowerCase());
    const pareceOtraCosa =
      /^(este|esta|esa|ese|el|la|los|las|mi|tu)?\s*(mes|ano|semana|dia)\b/.test(clienteSinTildes) ||
      /^(la|el)\s+(carpeta|papelera|raiz|archivo)\b/.test(clienteSinTildes);
    if (!cliente || STOPWORDS_NOMBRE.has(clienteSinTildes) || pareceOtraCosa) return null;
    return cliente;
  };

  // Pre-flight: "totales/total facturado de factura_X y factura_Y" (sin un verbo
  // claro como "dame"/"cuánto") a veces hace que el modelo interprete el primer
  // identificador como "abrir esa factura" en vez de pedir el total combinado de
  // todas las nombradas. Si se mencionan 2+ identificadores de factura junto a
  // "total(es)"/"facturado", se resuelve aquí directamente con "totales_facturas".
  const pideTotales = /\btotal(es)?\b/.test(msgLower) || /\bfacturado\b/.test(msgLower);
  const nombresFactura = [...msgLower.matchAll(/\bfacturas?(?:[\d_-]\w*)?\b/g)].map((m) => m[0]);
  const esTotalesMultiple =
    pideTotales &&
    nombresFactura.length >= 2 &&
    !new RegExp(`escane[ao](?:lo|la|los|las)?|abre(?:lo|la|los|las)?|abrir|muestra(?:me)?(?:lo|la|los|las)?|vendid|ranking`).test(
      msgSinTildes,
    );
  if (esTotalesMultiple) {
    const resultado = (await ejecutarTool(
      "totales_facturas",
      { facturas: nombresFactura },
      usuarioId,
      acciones,
    )) as Record<string, unknown>;
    if (typeof resultado.resumen === "string") return { respuesta: resultado.resumen, acciones };
  }

  // Pre-flight: "cuánto he facturado/total facturado [en abril] [de cliente X]"
  // sin nombrar facturas concretas — total agregado filtrado por periodo y/o
  // cliente (single-dimensión: si hay periodo, no se busca también cliente).
  // Distinto de esTotalesMultiple (varias facturas nombradas).
  const esTotalesGeneral = pideTotales && !esTotalesMultiple && nombresFactura.length < 2;
  if (esTotalesGeneral) {
    const { mes, anio } = detectarMesAnio(msgSinTildes);
    const cliente = !mes && !anio ? extraerClienteDeFrase(msgSinTildes, msgLower) : null;
    if (mes || anio || cliente) {
      const args: Record<string, unknown> = {};
      if (mes) args.mes = mes;
      if (anio) args.anio = anio;
      if (cliente) args.cliente = cliente;
      const resultado = (await ejecutarTool(
        "totales_facturas",
        args,
        usuarioId,
        acciones,
      )) as Record<string, unknown>;
      if (typeof resultado.resumen === "string") return { respuesta: resultado.resumen, acciones };
    }
  }

  // Pre-flight: ranking de productos ("qué es lo que más se vende [en julio]",
  // "lo más/menos vendido", "producto más vendido", "qué vendí más", "ranking de
  // ventas") con periodo opcional por NOMBRE de mes y/o año. El modelo pequeño a
  // veces acierta los argumentos ({mes:7, orden:"mas"}) pero NO llama a la tool:
  // los escupe como JSON en texto y se los muestra al usuario. Se resuelve aquí
  // de forma determinista con "ventas_top". No captura cuando se nombra un
  // producto concreto ("cuánto he vendido de X" no casa estos patrones) ni los
  // rankings de cliente (piden "vendid"/"se vende"/"ranking de ventas", no
  // "cliente"). Se compara sin tildes para tolerar acentos/enclíticos.
  const esRankingVentas =
    /\b(mas|menos)\s+vendid/.test(msgSinTildes) ||
    /\bse\s+vende[n]?\s+(mas|menos)\b/.test(msgSinTildes) ||
    /\bque\b.*\b(mas|menos)\b.*\bse\s+vende/.test(msgSinTildes) ||
    /\bque\s+(mas|menos)\s+(he\s+)?vend(i|o|ido)/.test(msgSinTildes) ||
    /\bproductos?\s+(mas|menos)\s+vendidos?\b/.test(msgSinTildes) ||
    /\branking\s+de\s+(ventas|productos|lo\s+(mas|menos))/.test(msgSinTildes);
  if (esRankingVentas) {
    const { mes, anio } = detectarMesAnio(msgSinTildes);
    const orden = /\bmenos\b/.test(msgSinTildes) ? "menos" : "mas";
    const args: Record<string, unknown> = { orden };
    if (mes) args.mes = mes;
    if (anio) args.anio = anio;
    // "qué es lo más vendido DE [cliente] X" — ranking de productos acotado a
    // ese cliente, no global. Solo si no hay periodo (single-dimensión).
    if (!mes && !anio) {
      const cliente = extraerClienteDeFrase(msgSinTildes, msgLower);
      if (cliente) args.cliente = cliente;
    }
    const resultado = (await ejecutarTool("ventas_top", args, usuarioId, acciones)) as Record<
      string,
      unknown
    >;
    if (typeof resultado.resumen === "string") return { respuesta: resultado.resumen, acciones };
  }

  // Periodo relativo ("este mes", "el mes pasado", "este año", "el año
  // pasado"...) — mismas frases que reconoce detectarMesAnio, para decidir si
  // un mensaje "tiene periodo" sin necesidad de un mes/año explícito.
  const RELATIVO_PERIODO =
    /\b(mes\s+pasado|el\s+mes\s+anterior|(este|el)\s+mes\b|mes\s+actual|ano\s+pasado|el\s+ano\s+anterior|(este|el)\s+ano\b|ano\s+actual)\b/;

  // Pre-flight: "busca/dame/qué facturas tengo de [mes/año]" es un LISTADO de
  // facturas concretas (con botón para abrir cada una), distinto de los totales
  // agregados ("cuánto facturé en abril" → totales_facturas) o el ranking de
  // productos ("qué más se vendió en abril" → ventas_top). Requiere la palabra
  // "factura(s)" + un periodo (mes y/o año, explícito o relativo); se excluye
  // si además pide total/facturado/vendido/ranking, que ya tienen su propio
  // pre-flight.
  const esListarFacturasPeriodo =
    /\bfacturas?\b/.test(msgSinTildes) &&
    !pideTotales &&
    !esRankingVentas &&
    (new RegExp(`\\b(${Object.keys(MESES).join("|")}|20\\d{2})\\b`).test(msgSinTildes) ||
      RELATIVO_PERIODO.test(msgSinTildes));
  if (esListarFacturasPeriodo) {
    const { mes, anio } = detectarMesAnio(msgSinTildes);
    const filtro: FiltroFacturas = {};
    const partes: string[] = [];
    if (mes) {
      const anioEfectivo = anio ?? new Date().getFullYear();
      const mm = String(mes).padStart(2, "0");
      const ultimoDia = new Date(anioEfectivo, mes, 0).getDate();
      filtro.desde = `${anioEfectivo}-${mm}-01`;
      filtro.hasta = `${anioEfectivo}-${mm}-${ultimoDia}`;
      const nombreMes = new Date(anioEfectivo, mes - 1).toLocaleString("es-ES", { month: "long" });
      partes.push(`${nombreMes} ${anioEfectivo}`);
    } else if (anio) {
      filtro.desde = `${anio}-01-01`;
      filtro.hasta = `${anio}-12-31`;
      partes.push(`${anio}`);
    }
    const { filas, total, paginas } = await listarFacturas(usuarioId, filtro, { pagina: 1, limite: 20 });
    const titulo = `Facturas de ${partes.join(" ")}`;
    return {
      respuesta: listadoFacturasMd(filas, titulo),
      acciones,
      tablaFacturas: {
        titulo,
        pagina: 1,
        totalPaginas: paginas,
        total,
        limite: 20,
        filtro,
        filas: filas.map((f) => ({
          archivoId: f.archivoId,
          archivoNombre: f.archivoNombre,
          fecha: formatearFecha(f.fecha),
          total: f.total,
        })),
      },
    };
  }

  // Pre-flight: "facturas de/en la carpeta X" (o "dentro de X") es un LISTADO
  // de facturas concretas filtrado por CARPETA (con botón para abrir cada
  // una). Se comprueba ANTES del listado por cliente de abajo para que tenga
  // prioridad cuando se menciona "la carpeta"/"dentro de" — sin esto,
  // extraerClienteDeFrase descarta "la carpeta X" (no parece un nombre de
  // cliente) pero no hacía nada más con la frase. Reutiliza resolverCarpeta
  // (mismo buscador por nombre/leaf-name que usan el resto de tools, con
  // manejo de ambigüedad).
  const matchFacturasDeCarpeta = msgSinTildes.match(
    /\bfacturas?\b.*?(?:dentro\s+de\s+(?:la\s+carpeta\s+)?|de\s+la\s+carpeta\s+|en\s+la\s+carpeta\s+)([\wÀ-ÿ/-]+)/,
  );
  if (matchFacturasDeCarpeta && !pideTotales && !esRankingVentas) {
    const nombreCarpeta = grupoOriginal(msgLower, matchFacturasDeCarpeta).trim();
    const res = await resolverCarpeta(usuarioId, nombreCarpeta);
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "facturas_de_carpeta");
    }
    const ruta = res.ruta!;
    const filtro: FiltroFacturas = { carpeta: ruta };
    const { filas, total, paginas } = await listarFacturas(usuarioId, filtro, { pagina: 1, limite: 20 });
    const titulo = `Facturas en ${ruta}`;
    return {
      respuesta: listadoFacturasMd(filas, titulo),
      acciones,
      tablaFacturas: {
        titulo,
        pagina: 1,
        totalPaginas: paginas,
        total,
        limite: 20,
        filtro,
        filas: filas.map((f) => ({
          archivoId: f.archivoId,
          archivoNombre: f.archivoNombre,
          fecha: formatearFecha(f.fecha),
          total: f.total,
        })),
      },
    };
  }

  // Pre-flight: "pásame/dame/búscame todas las facturas de [cliente] X" es un
  // LISTADO de facturas concretas filtrado por CLIENTE (con botón para abrir
  // cada una) — el modelo a veces no llamaba a ninguna tool para esto, o
  // confundía la petición con un ranking/total agregado. Distinto del listado
  // por periodo de arriba (que ya devolvió si detectó mes/año) y de los
  // totales/ranking agregados (pideTotales/esRankingVentas, con su propio
  // pre-flight). Reutiliza extraerClienteDeFrase (mismas exclusiones: periodo
  // relativo, "la carpeta X", "la papelera", palabras sueltas sin valor).
  if (/\bfacturas?\b/.test(msgSinTildes) && !pideTotales && !esRankingVentas) {
    const cliente = extraerClienteDeFrase(msgSinTildes, msgLower);
    if (cliente) {
      const filtro: FiltroFacturas = { cliente };
      const { filas, total, paginas } = await listarFacturas(usuarioId, filtro, { pagina: 1, limite: 20 });
      const titulo = `Facturas de ${cliente}`;
      return {
        respuesta: listadoFacturasMd(filas, titulo),
        acciones,
        tablaFacturas: {
          titulo,
          pagina: 1,
          totalPaginas: paginas,
          total,
          limite: 20,
          filtro,
          filas: filas.map((f) => ({
            archivoId: f.archivoId,
            archivoNombre: f.archivoNombre,
            fecha: formatearFecha(f.fecha),
            total: f.total,
          })),
        },
      };
    }
  }

  // Pre-flight: "¿tengo/hay/existe/dónde está... un archivo llamado X?" o
  // "busca el archivo X" es una simple comprobación de existencia/ubicación
  // que debería ser instantánea. El modelo a veces decide "comprobar"
  // escaneando la factura (OCR, lento, y en servidores sin GPU puede tirar
  // abajo el proceso) en vez de simplemente buscar por nombre, así que se
  // resuelve aquí directamente sin pasar por Ollama. Se separa la intención
  // (tengo/hay/existe/busca/dónde, en cualquier parte de la frase) del
  // nombre (lo que sigue a "archivo"/"fichero"), para no depender de que no
  // haya palabras de más en medio (ej. "existe EL archivo X").
  const tieneIntencionExistencia = new RegExp(`\\b(tengo|hay|existe|${VERBO_BUSCAR}|donde)\\b`).test(
    msgSinTildes,
  );
  const matchNombreArchivoBuscado = msgSinTildes.match(
    /(?:archivo|fichero)\s+(?:llamado\s+)?["']?([\wÀ-ÿ.-]+)/,
  );
  const matchExisteArchivo =
    tieneIntencionExistencia &&
    matchNombreArchivoBuscado &&
    !new RegExp(VERBO_BORRAR + "|" + VERBO_OTRAS_ACCIONES + "|muestra(?:me)?(?:lo|la|los|las)?|abre(?:lo|la|los|las)?").test(
      msgSinTildes,
    );
  if (matchExisteArchivo && matchNombreArchivoBuscado) {
    const nombreBuscado = grupoOriginal(msgLower, matchNombreArchivoBuscado);
    const lista = await buscarArchivos(usuarioId, nombreBuscado);
    if (lista.length === 0) {
      return { respuesta: `No, no tienes ningún archivo llamado "${nombreBuscado}".`, acciones };
    }
    const detalle = lista
      .map((a) => `- ${a.nombre}${a.carpeta !== "/" ? ` (${a.carpeta})` : ""}`)
      .join("\n");
    return {
      respuesta: `Sí, tienes:\n\n${detalle}`,
      acciones,
      archivos: lista.map((a) => ({ id: a.id, nombre: a.nombre })),
    };
  }

  // Pre-flight: "pásame/dame/muéstrame el resumen [de todo/de ventas/general]"
  // es el archivo "resumen-ventas.md" (el agregado que vive en /facturas, ver
  // facturas.service.ts), no las estadísticas recalculadas aparte — el
  // usuario quiere el mismo artefacto que ve en el explorador. Sin esto, "el
  // resumen de todo" no encaja con ninguna tool conocida por el modelo, y
  // tampoco lo encuentra resolverArchivo (busca por nombre, "todo" no es
  // parte del nombre real "resumen-ventas.md"). Se excluye si se nombra una
  // factura concreta (ej. "resumen de factura_03"), que es un caso distinto
  // ya cubierto por obtener_factura.
  const esResumenGeneral =
    /\bresumen(es)?\b/.test(msgSinTildes) &&
    /\b(de\s+todo|de\s+ventas|general)\b/.test(msgSinTildes) &&
    !/\bfacturas?[\d_-]/.test(msgSinTildes);
  if (esResumenGeneral) {
    const archivo = await localizarResumenVentas(usuarioId);
    if (!archivo) {
      return {
        respuesta:
          "Todavía no hay ningún resumen de ventas — se genera automáticamente en /facturas al escanear la primera factura.",
        acciones,
      };
    }
    const contenido = await leerTextoArchivo(archivo.id, usuarioId);
    return {
      respuesta: contenido,
      acciones,
      archivos: [{ id: archivo.id, nombre: archivo.nombre }],
    };
  }

  // Pre-flight: "lee/muestra/qué dice X" SIN nada más en el mensaje (solo verbo +
  // nombre, anclado al final). El modelo a veces solo confirma "lo he leído" en
  // vez de mostrar el contenido cuando este es muy corto/trivial, pese a la
  // instrucción explícita del prompt — se resuelve aquí leyendo de verdad y
  // devolviendo el contenido tal cual, sin pasar por el modelo. Si el mensaje
  // tiene algo más (una pregunta concreta sobre el contenido, ej. "qué dice el
  // contrato sobre los plazos"), el ancla `$` no casa y sigue el flujo normal.
  // El nombre se captura permitiendo ESPACIOS (`[\wÀ-ÿ.\- ]+?`, no-greedy) para
  // que "abre nuestras armas" / "muéstrame nuestras armas" (nombre de varias
  // palabras) funcionen — antes solo casaba una palabra y caía al modelo, que se
  // inventaba el contenido. La distinción "abrir un archivo" vs "pregunta sobre
  // un contenido" (ej. "qué dice el contrato sobre los plazos") se mantiene por
  // otra vía: si el nombre capturado no resuelve a un archivo real, NO se corta
  // aquí y sigue el flujo normal (modelo).
  const matchLeerSimpleRaw = msgSinTildes.match(
    new RegExp(
      `^(?:lee(?:me)?|que\\s+dice|${VERBO_ABRIR})\\s+(?:el\\s+archivo\\s+|la\\s+nota\\s+|el\\s+documento\\s+)?["']?([\\wÀ-ÿ.\\- ]+?)["']?\\s*\\??\\s*$`,
    ),
  );
  const nombreLeer = matchLeerSimpleRaw?.[1]?.trim();
  const matchLeerSimple =
    matchLeerSimpleRaw && nombreLeer && !STOPWORDS_NOMBRE.has(nombreLeer) ? matchLeerSimpleRaw : null;
  if (matchLeerSimple) {
    const res = await resolverArchivo(usuarioId, grupoOriginal(msgLower, matchLeerSimple).trim());
    if (res.opciones) {
      registrarAclaracion(usuarioId, "leer_archivo", {}, "nombre", res.opciones, res.sugerencia);
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "leer_archivo");
    }
    // Solo cortamos si de verdad hay un archivo; si no se encontró (res.error),
    // dejamos pasar al flujo normal (era una pregunta, no un "abre X").
    if (res.archivo) {
      const archivoBoton = [{ id: res.archivo.id, nombre: res.archivo.nombre }];
      // El indexado RAG (OCR) y el auto-escaneo de factura corren en segundo
      // plano al subir; mientras estadoEscaneo sea "pendiente"/"escaneando",
      // textoExtraido puede no existir todavía o tener un resultado intermedio
      // (ej. el ruido de Tesseract antes de que termine el resumen de factura
      // bonito) — se avisa en vez de devolver ese contenido a medias.
      if (res.archivo.estadoEscaneo === "pendiente" || res.archivo.estadoEscaneo === "escaneando") {
        return {
          respuesta: `"${res.archivo.nombre}" todavía se está procesando. Inténtalo de nuevo en unos segundos.`,
          acciones,
          archivos: archivoBoton,
        };
      }
      // Si el archivo YA tiene una factura escaneada en BD (datos estructurados:
      // numero/fecha/importes/líneas), se muestra ese resumen limpio en vez del
      // texto crudo de OCR/pdf-parse — el mismo formato que usan obtener_factura
      // y el .md de resumen, mucho más legible que el texto plano con el ruido
      // típico de una tabla escaneada (columnas mezcladas, etc).
      const factura = await obtenerFactura(usuarioId, res.archivo.id, res.archivo.nombre);
      if (factura.encontrada) {
        return { respuesta: factura.resumen!, acciones, archivos: archivoBoton };
      }
      try {
        const contenido = await leerTextoArchivo(res.archivo.id, usuarioId);
        return { respuesta: `**${res.archivo.nombre}**:\n\n${contenido}`, acciones, archivos: archivoBoton };
      } catch (err) {
        return {
          respuesta: err instanceof AppError ? err.message : "No pude leer el contenido del archivo.",
          acciones,
          archivos: archivoBoton,
        };
      }
    }
  }

  const esBorrarTodoCompleto =
    /borra(?:r|lo|la|los|las)?\s+todo\b|vacia(?:r|lo|la|los|las)?\s+todo\b|elimina(?:r|lo|la|los|las)?\s+todo\b|empeza(?:r)?\s+de\s+cero/.test(
      msgSinTildes,
    );
  const esBorrarSoloCarpetas =
    !esBorrarTodoCompleto &&
    !/archivo|fichero/.test(msgSinTildes) &&
    /(borra(?:r|lo|la|los|las)?|vacia(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)\s+todas?\s+(las\s+)?carpetas?/.test(msgSinTildes);
  const esBorrarSoloArchivos =
    !esBorrarTodoCompleto &&
    !esBorrarSoloCarpetas &&
    !/carpeta/.test(msgSinTildes) &&
    /(borra(?:r|lo|la|los|las)?|vacia(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)\s+todos?\s+(los\s+)?(archivos?|ficheros?)/.test(
      msgSinTildes,
    );

  if (esBorrarTodoCompleto || esBorrarSoloCarpetas || esBorrarSoloArchivos) {
    const tool = esBorrarTodoCompleto
      ? "borrar_todo"
      : esBorrarSoloCarpetas
        ? "borrar_todas_carpetas"
        : "borrar_todos_archivos";
    const resultado = await ejecutarTool(tool, {}, usuarioId, acciones);
    const r = resultado as Record<string, unknown>;
    if (r.ok) {
      return { respuesta: "Hecho.", acciones };
    }
  }

  // Pre-flight: "borra/elimina el archivo X" o, directamente, "borra/elimina X.ext"
  // (un archivo concreto, ni carpeta ni borrado masivo). El modelo no llama de
  // forma fiable a "eliminar_archivo" para esta frase tan directa: unas veces no
  // emite ninguna tool call válida, otras confunde "borra X" (sin la palabra
  // "archivo") con "lee X", o con "ábreme/muéstrame X" si X parece una factura.
  // Se resuelve aquí sin pasar por Ollama, igual que el resto de pre-flights de
  // borrado. El segundo patrón (sin "archivo") exige una extensión para no
  // capturar palabras sueltas como "borra **mi** reporte" o "borra **la**
  // carpeta" (esa además queda excluida por el filtro de "carpeta" de más abajo).
  const matchNombreArchivoABorrar =
    msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b.*?(?:archivo|fichero)\\s+(?:llamado\\s+)?["']?([\\wÀ-ÿ.-]+)`)) ||
    msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b\\s+["']?([\\wÀ-ÿ-]+\\.[a-z0-9]{1,5})\\b`)) ||
    (() => {
      // Sin extensión ni la palabra "archivo" (ej. "borra factura_F2026-101"):
      // solo se acepta si NO es una palabra suelta de las prohibidas.
      const m = msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b\\s+["']?([\\wÀ-ÿ-]{4,})\\b`));
      return m && !STOPWORDS_NOMBRE.has(m[1]!) ? m : null;
    })();
  const esBorrarUnArchivo = !!matchNombreArchivoABorrar && !/carpeta|papelera/.test(msgSinTildes);
  if (esBorrarUnArchivo && matchNombreArchivoABorrar) {
    const res = await resolverArchivo(usuarioId, grupoOriginal(msgLower, matchNombreArchivoABorrar));
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "eliminar_archivo", {}, "nombre", res.opciones, res.sugerencia);
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "eliminar_archivo");
    }
    await eliminarArchivo(res.archivo!.id, usuarioId);
    acciones.push(`Enviado a la papelera "${res.archivo!.nombre}"`);
    return { respuesta: "Hecho.", acciones };
  }

  // Pre-flight: "borra/elimina la carpeta X" (una carpeta concreta, ni archivo
  // ni borrado masivo). Igual que con archivos, el modelo no llama de forma
  // fiable a "eliminar_carpeta" para esta frase tan directa.
  const matchNombreCarpetaABorrar = msgSinTildes.match(
    new RegExp(`\\b${VERBO_BORRAR}\\b.*?carpeta\\s+(?:llamada\\s+)?["']?([\\wÀ-ÿ/-]+)`),
  );
  const esBorrarUnaCarpeta = !!matchNombreCarpetaABorrar && !/papelera/.test(msgSinTildes);
  if (esBorrarUnaCarpeta && matchNombreCarpetaABorrar) {
    const res = await resolverCarpeta(usuarioId, grupoOriginal(msgLower, matchNombreCarpetaABorrar));
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "eliminar_carpeta", {}, "ruta", res.opciones, res.sugerencia);
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "eliminar_carpeta");
    }
    const r = await eliminarCarpetaConContenido(usuarioId, res.ruta!);
    acciones.push(`Carpeta enviada a la papelera: ${res.ruta} (${r.borrados} archivo/s)`);
    return { respuesta: "Hecho.", acciones };
  }

  // Pre-flight: "crea/créame una nota/archivo/documento llamado X [con esto:/
  // con el contenido/que diga CONTENIDO]". El modelo casi nunca llama a
  // "crear_archivo" para esta petición: en su lugar intenta buscar o leer un
  // archivo que todavía no existe y responde que no lo encuentra, en vez de
  // crearlo. No aplica a carpetas (esas sí funcionan bien con el modelo).
  const esCrearNota =
    new RegExp(`\\b${VERBO_CREAR}\\b`).test(msgSinTildes) &&
    /\b(nota|archivo|documento|fichero)\b/.test(msgLower);
  if (esCrearNota) {
    const matchNombreExt = ultimoMensaje.match(/\b([\wÀ-ÿ-]+\.(?:md|txt))\b/i);
    const matchLlamado = ultimoMensaje.match(/llamad[oa]\s+["']?([\wÀ-ÿ.-]+)/i);
    const nombreNota = matchNombreExt?.[1] ?? (matchLlamado ? `${matchLlamado[1]}.md` : undefined);
    if (nombreNota) {
      const matchContenido = ultimoMensaje.match(
        /(?:con esto|con el contenido|con texto|que diga|que ponga)\s*:?\s*([\s\S]+)$/i,
      );
      const contenidoNota = matchContenido?.[1]?.trim() ?? "";
      const r = await crearArchivoTexto(usuarioId, nombreNota, "/", contenidoNota);
      acciones.push(`Archivo creado "${r.nombre}" en ${r.carpeta}`);
      return { respuesta: "Hecho.", acciones };
    }
  }

  // Pre-flight: "resume/qué tengo/qué documento(s) habla(n) sobre/de X" -
  // búsqueda semántica por tema. El modelo a veces no llama a "buscar_semantica"
  // para esta frase y en su lugar pide más detalles al usuario en vez de buscar.
  const matchResumenTema = ultimoMensaje.match(
    /(?:resum[eéi](?:me)?(?:lo|la|los|las)?|qu[eé]\s+tengo|qu[eé]\s+(?:documento|archivo)s?\s+habla(?:n)?)\s+(?:lo\s+que\s+tengo\s+)?(?:sobre|acerca\s+de|de)\s+(.+)$/i,
  );
  if (matchResumenTema) {
    const tema = matchResumenTema[1].trim().replace(/[?.!]+$/, "");
    const resultados = await buscarSemantica(usuarioId, tema);
    if (resultados.length === 0) {
      return { respuesta: `No encontré nada relevante sobre "${tema}".`, acciones };
    }
    const detalle = resultados
      .map((r) => `- **${r.nombre}**${r.carpeta !== "/" ? ` (${r.carpeta})` : ""}: ${extraerFragmento(r.fragmento, tema)}`)
      .join("\n");
    return { respuesta: `Esto es lo que encontré sobre "${tema}":\n\n${detalle}`, acciones };
  }

  // Pre-flight: "pásame/lista/dame todo lo que tengo (archivos y/o carpetas,
  // en la raíz o en general)" es una petición muy directa y frecuente para la
  // que el modelo a veces no llama a ninguna herramienta (responde "no recibí
  // respuesta de las funciones..."). Se detecta aquí y se construye la lista
  // directamente, sin depender del modelo.
  // El lookahead negativo evita que "resume LO QUE TENGO sobre el proyecto X"
  // (una búsqueda semántica por tema, no un listado) dispare esto solo por
  // contener la subcadena "que tengo".
  // Incluye VERBO_ABRIR junto a VERBO_LISTAR: "abre todos los archivos/X" no
  // se puede "abrir" literalmente de una sola vez, pero el sistema SÍ puede
  // mostrarlos con un botón "Abrir" por cada uno (igual que "muéstrame todos
  // los archivos") — sin esto, el modelo respondía "no puedo abrir archivos
  // directamente", lo cual es confuso porque SÍ puede abrir archivos (uno a
  // la vez, con el botón). Solo aplica con "todos/todas/mis/los/las" — "abre
  // el archivo X" (un nombre concreto) no encaja en estos patrones porque "el"
  // no es ninguno de esos calificadores, así que sigue su flujo normal.
  const VERBO_LISTAR_O_ABRIR = `(?:${VERBO_LISTAR}|${VERBO_ABRIR})`;
  const pideTodoGenerico =
    new RegExp(`(${VERBO_LISTAR_O_ABRIR})\\s+todo\\b`).test(msgSinTildes) ||
    /qu[eé]\s+tengo\b(?!\s+(sobre|de|acerca|relacionado))/.test(msgLower);
  const pideArchivos =
    new RegExp(`(${VERBO_LISTAR_O_ABRIR})\\s+(todos\\s+)?(mis\\s+)?(los\\s+)?(archivos?|ficheros?)\\b`).test(
      msgSinTildes,
    ) || /qu[eé]\s+(archivos?|ficheros?)\s+tengo/.test(msgLower);
  const pideCarpetas =
    new RegExp(`(${VERBO_LISTAR_O_ABRIR})\\s+(todas\\s+)?(mis\\s+)?(las\\s+)?carpetas?\\b`).test(
      msgSinTildes,
    ) || /qu[eé]\s+carpetas?\s+tengo/.test(msgLower);
  // Si el mensaje nombra ambos tipos (ej: "carpetas y ficheros") pero solo uno
  // coincide exactamente con el patrón verbo+sustantivo, se cuenta como ambos.
  const mencionaArchivoPalabra = /archivo|fichero/.test(msgLower);
  const mencionaCarpetaPalabra = /carpeta/.test(msgLower);
  const esListarAmbos =
    pideTodoGenerico ||
    (pideArchivos && pideCarpetas) ||
    ((pideArchivos || pideCarpetas) && mencionaArchivoPalabra && mencionaCarpetaPalabra);
  const esListarSoloArchivos = !esListarAmbos && pideArchivos;
  const esListarSoloCarpetas = !esListarAmbos && !esListarSoloArchivos && pideCarpetas;
  const soloRaiz = /\bra[ií]z\b/.test(msgLower);
  const esListado = esListarAmbos || esListarSoloArchivos || esListarSoloCarpetas;

  // Si además nombran una carpeta concreta ("dentro de la carpeta X", "de la
  // carpeta X"), el listado se limita a esa carpeta en vez de a todo el usuario
  // (antes "lista todo lo que tengo dentro de la carpeta X" ignoraba el filtro
  // y devolvía absolutamente todo).
  // Admite tanto "dentro de la carpeta X" / "de la carpeta X" como "dentro de X"
  // sin la palabra "carpeta" (ej. "lista todo lo que tengo dentro de demo11").
  const matchCarpetaObjetivo = esListado
    ? msgLower.match(/(?:dentro\s+de\s+(?:la\s+carpeta\s+)?|carpeta\s+)([\wÀ-ÿ/-]+)/)
    : null;
  if (matchCarpetaObjetivo) {
    const res = await resolverCarpeta(usuarioId, matchCarpetaObjetivo[1]);
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      return respuestaAclaracion(res.opciones, res.sugerencia, acciones, "listar_carpeta");
    }
    const ruta = res.ruta!;
    const partes: string[] = [];
    const sub =
      esListarAmbos || esListarSoloCarpetas
        ? (await listarTodasCarpetas(usuarioId)).filter((c) => c.ruta.startsWith(`${ruta}/`))
        : [];
    if (esListarAmbos || esListarSoloCarpetas) {
      partes.push(
        sub.length
          ? `**Carpetas dentro de ${ruta}** (${sub.length}):\n${sub.map((c) => `- ${c.ruta}`).join("\n")}`
          : `No hay carpetas dentro de ${ruta}.`,
      );
    }
    const tablaCarpetas =
      (esListarAmbos || esListarSoloCarpetas) && sub.length
        ? { titulo: `Carpetas dentro de ${ruta}`, limite: LISTADO_LIMITE, filas: sub.map((c) => ({ ruta: c.ruta })) }
        : undefined;

    const arch =
      esListarAmbos || esListarSoloArchivos
        ? await listarArchivos(usuarioId, ruta, 1, LISTADO_LIMITE)
        : { archivos: [], total: 0, paginas: 0 };
    if (esListarAmbos || esListarSoloArchivos) {
      partes.push(
        arch.total
          ? `**Archivos dentro de ${ruta}** (${arch.total}):\n${arch.archivos
              .map((a) => `- ${a.nombre}`)
              .join("\n")}${arch.total > arch.archivos.length ? `\n\n(mostrando ${arch.archivos.length} de ${arch.total})` : ""}`
          : `No hay archivos dentro de ${ruta}.`,
      );
    }
    const tablaArchivos =
      (esListarAmbos || esListarSoloArchivos) && arch.total
        ? {
            titulo: `Archivos dentro de ${ruta}`,
            carpeta: ruta,
            pagina: 1,
            totalPaginas: arch.paginas,
            total: arch.total,
            limite: LISTADO_LIMITE,
            filas: arch.archivos.map((a) => ({
              id: a.id,
              nombre: a.nombre,
              carpeta: a.carpeta,
              tamanoBytes: String(a.tamanoBytes),
              subidoEn: a.subidoEn,
            })),
          }
        : undefined;
    return { respuesta: partes.join("\n\n"), acciones, tablaCarpetas, tablaArchivos };
  }

  if (esListado) {
    const partes: string[] = [];
    const todas =
      esListarAmbos || esListarSoloCarpetas ? await listarTodasCarpetas(usuarioId) : [];
    const carpetas = soloRaiz ? todas.filter((c) => !c.ruta.slice(1).includes("/")) : todas;
    if (esListarAmbos || esListarSoloCarpetas) {
      partes.push(
        carpetas.length
          ? `**Carpetas** (${carpetas.length}):\n${carpetas.map((c) => `- ${c.ruta}`).join("\n")}`
          : `No tienes ninguna carpeta${soloRaiz ? " en la raíz" : ""}.`,
      );
    }
    const tablaCarpetas =
      (esListarAmbos || esListarSoloCarpetas) && carpetas.length
        ? {
            titulo: soloRaiz ? "Carpetas (raíz)" : "Carpetas",
            limite: LISTADO_LIMITE,
            filas: carpetas.map((c) => ({ ruta: c.ruta })),
          }
        : undefined;

    const carpetaFiltro = soloRaiz ? "/" : undefined;
    const arch =
      esListarAmbos || esListarSoloArchivos
        ? await listarArchivos(usuarioId, carpetaFiltro, 1, LISTADO_LIMITE)
        : { archivos: [], total: 0, paginas: 0 };
    if (esListarAmbos || esListarSoloArchivos) {
      partes.push(
        arch.total
          ? `**Archivos** (${arch.total}):\n${arch.archivos
              .map((a) => `- ${a.nombre}${!soloRaiz && a.carpeta !== "/" ? ` (${a.carpeta})` : ""}`)
              .join("\n")}${arch.total > arch.archivos.length ? `\n\n(mostrando ${arch.archivos.length} de ${arch.total})` : ""}`
          : `No tienes ningún archivo${soloRaiz ? " en la raíz" : ""}.`,
      );
    }
    const tablaArchivos =
      (esListarAmbos || esListarSoloArchivos) && arch.total
        ? {
            titulo: soloRaiz ? "Archivos (raíz)" : "Archivos",
            carpeta: carpetaFiltro,
            pagina: 1,
            totalPaginas: arch.paginas,
            total: arch.total,
            limite: LISTADO_LIMITE,
            filas: arch.archivos.map((a) => ({
              id: a.id,
              nombre: a.nombre,
              carpeta: a.carpeta,
              tamanoBytes: String(a.tamanoBytes),
              subidoEn: a.subidoEn,
            })),
          }
        : undefined;
    return { respuesta: partes.join("\n\n"), acciones, tablaCarpetas, tablaArchivos };
  }

  const MAX_ITER = 15;
  // Detecta si el modelo llama a la MISMA tool con los MISMOS argumentos otra
  // vez (visto con leer_archivo en respuestas difíciles de resumir: el modelo
  // se queda "atascado" repitiendo la llamada en vez de responder, agotando
  // las 15 iteraciones — varios minutos de espera para nada). Cuando se
  // detecta, se reutiliza el resultado ya obtenido (sin repetir el trabajo) y
  // se fuerza una respuesta final sin más herramientas en vez de seguir el bucle.
  const llamadasVistas = new Map<string, unknown>();

  for (let i = 0; i < MAX_ITER; i++) {
    const respuesta = await llamarOllama(messages);
    messages.push(respuesta);

    // Corrige nombres de tool inventados pero reconocibles (ej. "copiar_factura"
    // -> "copiar_archivo") incluso cuando vienen en el campo tool_calls real.
    let toolCalls = (respuesta.tool_calls ?? []).flatMap((tc) => {
      const nombreReal = remapearNombreTool(tc.function.name);
      return nombreReal ? [{ ...tc, function: { ...tc.function, name: nombreReal } }] : [];
    });
    // Respaldo: si el modelo no usó el campo tool_calls pero escribió las
    // llamadas como texto JSON en content, las extraemos y ejecutamos.
    if (toolCalls.length === 0 && respuesta.content) {
      toolCalls = extraerToolCallsDeTexto(respuesta.content);
    }
    if (toolCalls.length === 0) {
      if (
        respuesta.content &&
        (pareceIntentoToolCallInvalido(respuesta.content) || esRespuestaInutil(respuesta.content))
      ) {
        return {
          respuesta: "No he podido completar esa acción. ¿Puedes reformular la petición?",
          acciones,
        };
      }
      return { respuesta: respuesta.content || "Hecho.", acciones };
    }

    // Resúmenes preconstruidos (markdown listo para mostrar directamente)
    const resumenes: string[] = [];
    let huboRepetida = false;

    for (const tc of toolCalls) {
      const args =
        typeof tc.function.arguments === "string"
          ? (JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>)
          : tc.function.arguments;
      const firma = `${tc.function.name}:${JSON.stringify(args)}`;
      let resultado: unknown;
      if (llamadasVistas.has(firma)) {
        huboRepetida = true;
        resultado = llamadasVistas.get(firma);
      } else {
        resultado = await ejecutarTool(tc.function.name, args, usuarioId, acciones);
        llamadasVistas.set(firma, resultado);
      }
      messages.push({ role: "tool", content: JSON.stringify(resultado) });

      const r = resultado as Record<string, unknown>;

      // Si hace falta aclarar entre varias coincidencias, se construye la
      // pregunta aquí mismo: dejarlo en manos del modelo a veces resultaba en
      // que preguntara "¿cuál quieres?" sin listar ninguna opción real.
      if (r.necesita_aclaracion === true && Array.isArray(r.opciones)) {
        return respuestaAclaracion(r.opciones as OpcionAclaracion[], r.sugerencia === true, acciones, tc.function.name);
      }

      // Cualquier herramienta que devuelva un "resumen" (facturas, ventas_top,
      // totales_facturas) trae el markdown ya formateado con € server-side.
      if (typeof r.resumen === "string") {
        resumenes.push(r.resumen);
      }

      if (typeof r.archivoId === "string" && typeof r.archivoNombre === "string") {
        archivosParaAbrir.push({ id: r.archivoId, nombre: r.archivoNombre });
      }
    }

    // Si TODAS las llamadas de esta iteración tienen resumen preconstruido, devolver
    // directamente sin otro turno del modelo (evita que reformatee mal o invente cosas).
    if (resumenes.length === toolCalls.length && resumenes.length > 0) {
      return {
        respuesta: [...new Set(resumenes)].join("\n\n---\n\n"),
        acciones,
        archivos: archivosParaAbrir.length ? archivosParaAbrir : undefined,
      };
    }

    // El modelo repitió una llamada idéntica a una ya hecha: está atascado (no
    // sabe qué más hacer con el resultado) en vez de responder. Seguir el bucle
    // solo quemaría las iteraciones restantes sin ganar nada. Se le pide la
    // respuesta final YA, sin la opción de volver a llamar a ninguna herramienta
    // (sin "tools" en la petición, así es imposible que repita).
    if (huboRepetida) {
      messages.push({
        role: "user",
        content:
          "Ya tienes los datos reales en el resultado de la herramienta (mensaje anterior, rol \"tool\"). Usa ESOS datos para responder ahora a la pregunta del usuario, en texto. No describas qué herramientas existen ni para qué sirven, y no vuelvas a llamar a ninguna.",
      });
      const final = await llamarOllama(messages, true);
      return {
        respuesta:
          final.content && !esRespuestaInutil(final.content)
            ? final.content
            : "He realizado las acciones solicitadas.",
        acciones,
        archivos: archivosParaAbrir.length ? archivosParaAbrir : undefined,
      };
    }
  }

  // Si se agotaron las iteraciones sin repetir llamadas, pedir una respuesta
  // final sin herramientas en vez de devolver el JSON crudo del último mensaje.
  messages.push({
    role: "user",
    content:
      "Ya tienes los datos reales en el resultado de la herramienta (mensaje anterior, rol \"tool\"). Usa ESOS datos para responder ahora a la pregunta del usuario, en texto. No describas qué herramientas existen ni para qué sirven, y no vuelvas a llamar a ninguna.",
  });
  const final = await llamarOllama(messages, true);
  return {
    respuesta:
      final.content && !esRespuestaInutil(final.content)
        ? final.content
        : "He realizado las acciones solicitadas.",
    acciones,
  };
};
