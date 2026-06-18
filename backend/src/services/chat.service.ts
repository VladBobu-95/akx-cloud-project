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
} from "./carpetas.service";
import { buscarSemantica } from "./rag.service";
import {
  escanearFactura,
  obtenerFactura,
  ventasTop,
  totalesFacturado,
  asegurarFacturasEscaneadas,
  rankingMd,
  totalesMd,
  type FiltroFacturas,
} from "./facturas.service";

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

// Extrae una ruta de carpeta válida de los args. El modelo a veces omite "ruta"
// o la pone bajo otra clave; sin esto, String(undefined) === "undefined" creaba
// carpetas literales "/undefined".
const extraerRuta = (args: Record<string, unknown>): string | undefined => {
  const candidato = args.ruta ?? args.carpeta ?? args.nombre ?? args.path;
  return typeof candidato === "string" && candidato.trim() ? candidato : undefined;
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

const SYSTEM_PROMPT = `Eres el asistente de AKX Cloud, una app de almacenamiento de archivos.
Gestionas los archivos y carpetas del usuario USANDO SIEMPRE las herramientas; nunca respondas de memoria ni inventes.

Cómo actuar:
- Las acciones sobre archivos (copiar/mover/renombrar/borrar) se hacen indicando el NOMBRE del archivo; el sistema lo localiza solo. No necesitas ids.
- Si quieres ver qué hay, usa "buscar_archivos" (con "texto" para filtrar por nombre, o "carpeta" para listar una carpeta; sin nada lista los más recientes).
- Para crear una carpeta usa "crear_carpeta" con la "ruta" (ej: "/facturas"). Si el usuario NO indica dónde (solo da un nombre, ej: "creame una carpeta demo"), la ruta es simplemente "/<nombre>" en la RAÍZ; no inventes ni anides una ubicación a partir de carpetas mencionadas antes en la conversación. Para listarlas, "listar_carpetas". NUNCA llames a "crear_carpeta" como paso previo a "renombrar_carpeta", "mover_carpeta" ni ninguna otra operación: si el usuario menciona una carpeta, asume que ya existe y actúa directamente.
- Para crear un archivo/nota/documento (.md o .txt) DEBES llamar a "crear_archivo" (nombre, carpeta y contenido). Nunca describas que lo creas sin llamar a la herramienta. Si el usuario NO indica carpeta, NO pongas "carpeta" (se creará en la raíz); no te inventes una carpeta a partir del nombre.
- "eliminar_carpeta" borra la carpeta ENTERA (carpeta + contenido). "vaciar_carpeta" borra SOLO el contenido y deja la carpeta: úsalo si piden "borra el contenido de X" o "vacía X".
- Si el usuario pide borrar TODAS las carpetas (ej: "borra todas las carpetas"), usa "borrar_todas_carpetas": borra las carpetas Y su contenido (a la papelera), pero NO toca los archivos que ya estaban en la raíz. Si pide borrar TODOS los archivos/ficheros (ej: "borra todos los ficheros") sin mencionar carpetas, usa "borrar_todos_archivos": borra todos los archivos pero deja las carpetas (ahora vacías). Si pide borrar/vaciar TODO (absolutamente todo, incluida la raíz) o "empezar de cero", usa "borrar_todo".
- Para mover/renombrar/copiar/eliminar/vaciar una carpeta que YA EXISTE, indica solo su NOMBRE (ej: "tmp"); el sistema la localiza igual que con archivos, sin necesidad de la ruta completa. Solo da la ruta completa (ej: "/proyectos/tmp") si quieres ser explícito o si hay varias carpetas con el mismo nombre y te piden aclarar. La ruta completa SÍ es obligatoria al CREAR una carpeta nueva (no existe nada que localizar) y al indicar el destino de un mover/copiar.
- Para listar carpetas usa "listar_carpetas" (devuelve TODAS, incluidas las que tienen archivos).
- Papelera: "listar_papelera", "restaurar_archivo" (recuperar), "borrar_permanente" (definitivo, irreversible) y "vaciar_papelera". OJO: "borra/elimina X de la papelera" significa BORRAR DEFINITIVAMENTE ese archivo (usa "borrar_permanente"), NO recuperarlo. Solo uses "restaurar_archivo" si el usuario dice explícitamente "restaura"/"recupera"/"saca X de la papelera".
- Para responder sobre el contenido de un archivo CONCRETO (sabes su nombre) usa "leer_archivo". Para cifras de uso, "estadisticas".
- Para preguntas sobre el CONTENIDO sin saber en qué archivo está (ej: "¿qué documento habla de X?", "¿dónde dice algo sobre Y?", "resume lo que tengo sobre Z") usa "buscar_semantica": busca por significado dentro de todos los documentos y devuelve los más relevantes con un fragmento. Responde basándote en esos fragmentos y di de qué archivo salen.
- FACTURAS — elige la herramienta correcta:
  • Si el usuario pide VER o RESUMIR una factura específica YA escaneada → usa "obtener_factura" (lee de BD, rápido, sin re-procesar el PDF).
  • Si el usuario pide ESCANEAR/PROCESAR una o varias facturas concretas por nombre → usa "escanear_factura" UNA VEZ POR CADA archivo mencionado (nunca uses "escanear_todas_facturas" si el usuario nombró archivos específicos).
  • Si el usuario pide escanear/procesar TODAS sus facturas sin nombrarlas → usa "escanear_todas_facturas".
- ANALÍTICA DE FACTURAS — llama a la herramienta INMEDIATAMENTE, sin preguntar:
  • Rankings de productos o buscar un producto ("qué vendí más", "lo más/menos vendido", "ranking", "cuánto he vendido de X") → "ventas_top".
  • Totales facturados ("cuánto he facturado", "total gastado", "cuánto le he facturado a X") → "totales_facturas".
  • Aplica filtros SOLO si el usuario los menciona, extrayéndolos del mensaje:
    - Si nombra facturas concretas (por nº o por nombre de archivo) → ponlas TODAS en "facturas" (array).
    - Si nombra a quién se factura → "cliente"; si nombra el proveedor/quien emite → "emisor".
    - Periodo → "mes"/"anio" o "desde"/"hasta". Para menos vendido usa orden:"menos".
  • Si no hay filtros, llama la herramienta sin parámetros (cubre todas las facturas).
- Si una acción devuelve "necesita_aclaracion" con varias opciones, pregunta al usuario cuál de ellas quiere.
- Las carpetas son rutas tipo "/facturas/2026" ("/" es la raíz).
- Haz lo que pide el usuario en la misma respuesta, sin pedir confirmaciones innecesarias.

MUY IMPORTANTE (no inventar):
- NUNCA afirmes que has creado, movido, copiado o borrado algo si no has llamado a la herramienta correspondiente y te ha devuelto "ok".
- NUNCA te inventes la ruta de una carpeta. Antes de borrar/vaciar/mover/renombrar una carpeta, llama a "listar_carpetas" y usa EXACTAMENTE una de las rutas que devuelve. Si el usuario da un nombre suelto (ej: "demo" o "11234"), busca en esa lista la ruta real que coincide (ej: "/11234/demo") y úsala tal cual.
- Si una herramienta devuelve "error" (por ejemplo "no existe la carpeta"), NO digas que la acción se hizo: explica el error al usuario o corrige la ruta y reintenta.
- NO te inventes listados de archivos ni de carpetas: si el usuario los pide, llama a "listar_carpetas" o "buscar_archivos" y básate SOLO en su resultado.
- NO escribas tú marcas de verificación (✓) ni listas de acciones: el sistema ya las muestra automáticamente.
- Responde SIEMPRE en español, basándote únicamente en lo que devuelven las herramientas.

ESTILO DE RESPUESTA (muy breve):
- Cuando una acción se ejecuta con éxito, responde con UNA frase corta o simplemente "Hecho.". El sistema ya muestra el detalle con ✓, así que NO repitas la ruta, NO des recuentos de archivos, NI expliques detalles internos (p. ej. "no se encontraron archivos", "la carpeta estaba vacía").
- Responde SOLO a la última petición del usuario. No comentes ni menciones peticiones anteriores de la conversación.
- Si una herramienta falla, di el motivo en una frase. Si todo va bien, no añadas explicaciones de más ni preguntes "¿necesitas algo más?".
- FACTURAS: el sistema ya muestra el resumen completo automáticamente cuando se escanea o consulta una factura — tú solo di "Hecho." o una frase muy breve. Nunca repitas los datos de la factura en tu texto.`;

// Definición de herramientas (function calling) que se ofrecen al modelo.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "buscar_archivos",
      description:
        "Busca archivos del usuario por nombre, o lista los de una carpeta. Devuelve id, nombre y carpeta.",
      parameters: {
        type: "object",
        properties: {
          texto: { type: "string", description: "Texto a buscar en el nombre del archivo" },
          carpeta: { type: "string", description: "Ruta de carpeta para listar, ej: /facturas" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copiar_archivo",
      description: "Crea una copia de un archivo (indica su nombre). Opcionalmente en otra carpeta.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del archivo a copiar" },
          carpeta: { type: "string", description: "carpeta destino (opcional)" },
        },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mover_archivo",
      description: "Mueve un archivo (por su nombre) a otra carpeta.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del archivo" },
          carpeta: { type: "string", description: "carpeta destino, ej: /docs" },
        },
        required: ["nombre", "carpeta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "renombrar_archivo",
      description: "Cambia el nombre de un archivo.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre actual del archivo" },
          nuevo_nombre: { type: "string", description: "nuevo nombre" },
        },
        required: ["nombre", "nuevo_nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_archivo",
      description: "Envía un archivo (por su nombre) a la papelera.",
      parameters: {
        type: "object",
        properties: { nombre: { type: "string", description: "nombre del archivo" } },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_carpeta",
      description:
        "Crea una carpeta. Indica la ruta completa, ej: /facturas o /facturas/2026. Si el usuario no indica ubicación, usa solo \"/<nombre>\" (raíz).",
      parameters: {
        type: "object",
        properties: { ruta: { type: "string", description: "ruta de la carpeta a crear" } },
        required: ["ruta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_archivo",
      description:
        "Crea un archivo de texto (por ejemplo .md o .txt) con un contenido. Úsalo cuando el usuario pida crear una nota o un documento.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del archivo, ej: notas.md" },
          carpeta: { type: "string", description: "carpeta destino, ej: /test ('/' si no se indica)" },
          contenido: { type: "string", description: "contenido del archivo (texto/markdown)" },
        },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_carpeta",
      description: "Borra la carpeta ENTERA (la carpeta y su contenido van a la papelera). Indica la ruta, ej: /demo.",
      parameters: {
        type: "object",
        properties: { ruta: { type: "string", description: "ruta de la carpeta a borrar" } },
        required: ["ruta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vaciar_carpeta",
      description:
        "Vacía el CONTENIDO de una carpeta (envía sus archivos a la papelera) pero MANTIENE la carpeta. Úsalo cuando pidan 'borra el contenido de la carpeta X' o 'vacía la carpeta X'. Si piden borrar/vaciar los archivos de la RAÍZ (sin afectar a las carpetas), usa ruta: \"/\" — solo borra los archivos sueltos en la raíz, no los que están dentro de carpetas.",
      parameters: {
        type: "object",
        properties: { ruta: { type: "string", description: "ruta de la carpeta a vaciar" } },
        required: ["ruta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_carpetas",
      description:
        "Devuelve TODAS las carpetas del usuario (solo rutas de carpetas, nunca archivos). Muestra exactamente las rutas que devuelve, sin añadir ni inventar nada.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "borrar_todo",
      description:
        "Borra TODO: envía a la papelera todos los archivos del usuario y elimina todas sus carpetas. Úsalo cuando el usuario pida borrar/vaciar TODO (carpetas Y archivos) o empezar de cero. Si solo pide borrar las carpetas, usa 'borrar_todas_carpetas'; si solo pide borrar los archivos/ficheros, usa 'borrar_todos_archivos'. Los archivos quedan recuperables desde la papelera.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "borrar_todas_carpetas",
      description:
        "Borra TODAS las carpetas Y su contenido (van a la papelera), pero NO toca los archivos que ya estaban en la raíz fuera de cualquier carpeta. Úsalo cuando el usuario pida borrar/eliminar/quitar TODAS las carpetas (con o sin mencionar sus archivos), pero sin pedir un borrado total de TODO.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "borrar_todos_archivos",
      description:
        "Envía a la papelera TODOS los archivos/ficheros del usuario (de cualquier carpeta y de la raíz), pero NO borra ninguna carpeta. Úsalo cuando el usuario pida borrar/eliminar TODOS los archivos o ficheros SIN mencionar carpetas.",
      parameters: { type: "object", properties: {} },
    },
  },
  // --- Papelera ---
  {
    type: "function",
    function: {
      name: "listar_papelera",
      description: "Lista los archivos que están en la papelera.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "restaurar_archivo",
      description:
        "Recupera un archivo de la papelera y lo devuelve a su sitio. Úsalo SOLO si el usuario pide explícitamente 'restaurar' o 'recuperar' un archivo, nunca para 'borrar X de la papelera'.",
      parameters: {
        type: "object",
        properties: { nombre: { type: "string", description: "nombre del archivo en la papelera" } },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "borrar_permanente",
      description:
        "Borra DEFINITIVAMENTE un archivo de la papelera (no se puede deshacer). Úsalo para 'borra/elimina X de la papelera' o 'borra X definitivamente'.",
      parameters: {
        type: "object",
        properties: { nombre: { type: "string", description: "nombre del archivo en la papelera" } },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vaciar_papelera",
      description: "Vacía la papelera: borra definitivamente todos los archivos eliminados.",
      parameters: { type: "object", properties: {} },
    },
  },
  // --- Operaciones de carpeta ---
  {
    type: "function",
    function: {
      name: "mover_carpeta",
      description: "Mueve una carpeta (con su contenido) dentro de otra carpeta.",
      parameters: {
        type: "object",
        properties: {
          ruta: { type: "string", description: "ruta de la carpeta a mover, ej: /a" },
          carpeta_destino: { type: "string", description: "carpeta padre destino, ej: /b ('/' para la raíz)" },
        },
        required: ["ruta", "carpeta_destino"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "renombrar_carpeta",
      description: "Cambia el nombre de una carpeta (mantiene su contenido).",
      parameters: {
        type: "object",
        properties: {
          ruta: { type: "string", description: "ruta de la carpeta, ej: /a" },
          nuevo_nombre: { type: "string", description: "nuevo nombre (sin barras)" },
        },
        required: ["ruta", "nuevo_nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copiar_carpeta",
      description: "Copia una carpeta y todo su contenido. Opcionalmente dentro de otra carpeta.",
      parameters: {
        type: "object",
        properties: {
          ruta: { type: "string", description: "ruta de la carpeta a copiar" },
          carpeta_destino: { type: "string", description: "carpeta padre destino (opcional)" },
        },
        required: ["ruta"],
      },
    },
  },
  // --- Leer / estadísticas ---
  {
    type: "function",
    function: {
      name: "leer_archivo",
      description:
        "Lee y devuelve el contenido de un archivo de texto (.md/.txt/csv/json) por su nombre. Úsalo SIEMPRE que el usuario pregunte qué dice / qué pone / qué contiene un archivo, o pida resumirlo o leerlo. NO pidas el contenido al usuario.",
      parameters: {
        type: "object",
        properties: { nombre: { type: "string", description: "nombre del archivo" } },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "estadisticas",
      description: "Devuelve cuántos archivos y carpetas tiene el usuario y el espacio usado.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_semantica",
      description:
        "Busca por SIGNIFICADO dentro del CONTENIDO de los documentos del usuario (no por nombre). Úsalo cuando pregunten qué documento habla de un tema, o pidan información que estaría DENTRO de los archivos. Devuelve los archivos más relevantes con un fragmento de su texto.",
      parameters: {
        type: "object",
        properties: {
          consulta: { type: "string", description: "lo que se quiere encontrar, en lenguaje natural" },
        },
        required: ["consulta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escanear_factura",
      description:
        "Escanea una factura (PDF o imagen) por su nombre: extrae sus datos (artículos, cantidades, precios, totales) y los guarda. Crea un resumen .md. Úsalo cuando pidan escanear/procesar/leer una factura.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del archivo de la factura" },
          pista: { type: "string", description: "opcional: qué contiene, si el usuario lo aclara" },
        },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escanear_todas_facturas",
      description:
        "Escanea TODAS las facturas (PDFs) del usuario de una sola vez y devuelve cuántas se procesaron. Úsalo cuando pidan 'escanea todas las facturas', 'procesa todas', 'analiza mis facturas', 'hazme un resumen de todas las facturas', 'qué facturas tengo', etc. Tras el escaneo, ventas_top devolverá el ranking completo.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "obtener_factura",
      description:
        "Lee el resumen de una factura YA ESCANEADA desde la base de datos (sin volver a procesar el PDF). Úsalo cuando el usuario pida 'dame el resumen de X', 'muéstrame la factura X', 'qué contiene X', etc., siempre que la factura ya haya sido escaneada antes.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del archivo de la factura, ej: FAC-2026-001.pdf" },
        },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ventas_top",
      description:
        "Ranking de productos por ventas (unidades e importe), o búsqueda de un producto concreto. Úsala cuando pregunten qué se ha vendido más/menos, el ranking de ventas, o cuánto se ha vendido de un producto. TODOS los filtros son OPCIONALES y se combinan: úsalos solo si el usuario los menciona. Si nombra facturas concretas, ponlas en 'facturas'. Si nombra un cliente o proveedor/emisor, usa 'cliente'/'emisor'. Si pregunta por un producto concreto, usa 'producto'.",
      parameters: {
        type: "object",
        properties: {
          facturas: {
            type: "array",
            items: { type: "string" },
            description: "nº de factura o nombre de archivo de las facturas a incluir, ej: [\"FAC-001\", \"factura_enero.pdf\"]",
          },
          cliente: { type: "string", description: "filtrar por cliente (a quién se factura)" },
          emisor: { type: "string", description: "filtrar por emisor/proveedor (quién emite)" },
          producto: { type: "string", description: "filtrar por un producto concreto, ej: tornillos" },
          orden: { type: "string", enum: ["mas", "menos"], description: "'mas' = más vendido (defecto), 'menos' = menos vendido" },
          mes: { type: "number", description: "mes 1-12, solo si lo especifica" },
          anio: { type: "number", description: "año, solo si lo especifica" },
          desde: { type: "string", description: "fecha inicio YYYY-MM-DD (opcional)" },
          hasta: { type: "string", description: "fecha fin YYYY-MM-DD (opcional)" },
          limite: { type: "number", description: "cuántos productos devolver (defecto 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "totales_facturas",
      description:
        "Devuelve los TOTALES facturados (nº de facturas, subtotal, IVA y total). Úsala cuando pregunten cuánto han facturado/gastado en total, en un periodo, a un cliente, de un emisor, o de unas facturas concretas. TODOS los filtros son OPCIONALES: úsalos solo si el usuario los menciona.",
      parameters: {
        type: "object",
        properties: {
          facturas: {
            type: "array",
            items: { type: "string" },
            description: "nº de factura o nombre de archivo de las facturas a incluir",
          },
          cliente: { type: "string", description: "filtrar por cliente" },
          emisor: { type: "string", description: "filtrar por emisor/proveedor" },
          mes: { type: "number", description: "mes 1-12, solo si lo especifica" },
          anio: { type: "number", description: "año, solo si lo especifica" },
          desde: { type: "string", description: "fecha inicio YYYY-MM-DD (opcional)" },
          hasta: { type: "string", description: "fecha fin YYYY-MM-DD (opcional)" },
        },
      },
    },
  },
];

// Localiza un archivo por su nombre. Devuelve el archivo, un error o varias opciones.
const resolverArchivo = async (
  usuarioId: string,
  nombre: string,
): Promise<{ archivo?: Archivo; error?: string; opciones?: { nombre: string; carpeta: string }[] }> => {
  const lista = await buscarArchivos(usuarioId, nombre);
  if (lista.length === 0) return { error: `No encontré ningún archivo que coincida con "${nombre}".` };
  const exacto = lista.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase());
  if (exacto) return { archivo: exacto };
  if (lista.length === 1) return { archivo: lista[0] };
  return { opciones: lista.map((a) => ({ nombre: a.nombre, carpeta: a.carpeta })) };
};

// Localiza una carpeta EXISTENTE por nombre o ruta completa. Si el argumento ya
// parece una ruta (empieza por "/"), se usa tal cual (los servicios validan que
// exista). Si es solo un nombre (ej. "tmp"), busca entre TODAS las carpetas del
// usuario cualquiera cuyo último tramo coincida: así no hace falta dar la ruta
// completa para operar sobre una carpeta anidada, igual que ya pasa con archivos.
const resolverCarpeta = async (
  usuarioId: string,
  nombreORuta: string,
): Promise<{ ruta?: string; error?: string; opciones?: string[] }> => {
  const texto = nombreORuta.trim();
  if (texto.startsWith("/")) return { ruta: normalizarRuta(texto) };
  const todas = await listarTodasCarpetas(usuarioId);
  const buscado = texto.toLowerCase();
  const coincidencias = todas.filter((c) => hojaRuta(c.ruta).toLowerCase() === buscado);
  if (coincidencias.length === 0) {
    return { error: `No encontré ninguna carpeta llamada "${nombreORuta}".` };
  }
  if (coincidencias.length === 1) return { ruta: coincidencias[0].ruta };
  return { opciones: coincidencias.map((c) => c.ruta) };
};

// Localiza un archivo dentro de la papelera por su nombre.
const resolverEnPapelera = async (
  usuarioId: string,
  nombre: string,
): Promise<{ archivo?: Archivo; error?: string; opciones?: { nombre: string; carpeta: string }[] }> => {
  const lista = (await listarPapelera(usuarioId)).filter((a) =>
    a.nombre.toLowerCase().includes(nombre.toLowerCase()),
  );
  if (lista.length === 0)
    return { error: `No hay ningún archivo en la papelera que coincida con "${nombre}".` };
  const exacto = lista.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase());
  if (exacto) return { archivo: exacto };
  if (lista.length === 1) return { archivo: lista[0] };
  return { opciones: lista.map((a) => ({ nombre: a.nombre, carpeta: a.carpeta })) };
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
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await copiarArchivo(res.archivo!.id, usuarioId, {
          carpeta: typeof args.carpeta === "string" ? args.carpeta : undefined,
        });
        acciones.push(`Copiado "${r.nombre}"`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "mover_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          carpeta: String(args.carpeta),
        });
        acciones.push(`Movido "${r.nombre}" a ${args.carpeta}`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "renombrar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          nombre: String(args.nuevo_nombre),
        });
        acciones.push(`Renombrado a "${r.nombre}"`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "eliminar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await eliminarCarpetaConContenido(usuarioId, res.ruta!);
        acciones.push(`Carpeta enviada a la papelera: ${res.ruta} (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      case "vaciar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a vaciar." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        await restaurarArchivo(res.archivo!.id, usuarioId);
        acciones.push(`Restaurado "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre, resumen: "Hecho." };
      }
      case "borrar_permanente": {
        const res = await resolverEnPapelera(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
        // Busca todos los PDFs e imágenes y los escanea en paralelo.
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
            try {
              await escanearFactura(usuarioId, a.id);
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
        const r = await obtenerFactura(usuarioId, String(args.nombre));
        if (!r.encontrada) {
          return { error: `No encontré una factura escaneada para "${args.nombre}". Primero escanéala con escanear_factura.` };
        }
        return { ok: true, resumen: r.resumen, numero: r.numero };
      }
      case "escanear_factura": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
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
      default:
        return { error: `herramienta desconocida: ${nombre}` };
    }
  } catch (err) {
    const mensaje = err instanceof AppError ? err.message : "error al ejecutar la acción";
    return { error: mensaje };
  }
};

const NOMBRES_TOOLS = new Set(TOOLS.map((t) => t.function.name));

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
      if (parsed && typeof parsed.name === "string" && NOMBRES_TOOLS.has(parsed.name)) {
        calls.push({
          function: {
            name: parsed.name,
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

// Llama a Ollama /api/chat (sin streaming).
const llamarOllama = async (messages: OllamaMessage[]): Promise<OllamaMessage> => {
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        tools: TOOLS,
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0 },
      }),
    });
  } catch {
    throw new AppError(503, "El asistente no está disponible (no se puede conectar con Ollama).");
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

// Orquesta la conversación con el modelo y el bucle de herramientas.
export const chatear = async (
  usuarioId: string,
  mensajes: MensajeChat[],
): Promise<{ respuesta: string; acciones: string[] }> => {
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

  // Pre-flight: el modelo no siempre llama de forma fiable a "borrar_todo" /
  // "borrar_todas_carpetas" / "borrar_todos_archivos" para frases muy directas,
  // así que se detectan aquí. Distingue "borra TODO" (incluida la raíz) de
  // "borra todas las carpetas" (carpetas + su contenido, raíz intacta) de
  // "borra todos los archivos/ficheros" (archivos, carpetas intactas).
  const ultimoMensaje = mensajes[mensajes.length - 1]?.contenido ?? "";
  const msgLower = ultimoMensaje.toLowerCase();
  const esBorrarTodoCompleto =
    /borra(r)?\s+todo\b|vac[ií]a(r)?\s+todo\b|elimina(r)?\s+todo\b|empeza(r)?\s+de\s+cero/.test(
      msgLower,
    );
  const esBorrarSoloCarpetas =
    !esBorrarTodoCompleto &&
    !/archivo|fichero/.test(msgLower) &&
    /(borra(r)?|vac[ií]a(r)?|elimina(r)?|quita(r)?)\s+todas?\s+(las\s+)?carpetas?/.test(msgLower);
  const esBorrarSoloArchivos =
    !esBorrarTodoCompleto &&
    !esBorrarSoloCarpetas &&
    !/carpeta/.test(msgLower) &&
    /(borra(r)?|vac[ií]a(r)?|elimina(r)?|quita(r)?)\s+todos?\s+(los\s+)?(archivos?|ficheros?)/.test(
      msgLower,
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

  // Pre-flight: "pásame/lista/dame todo lo que tengo (archivos y/o carpetas,
  // en la raíz o en general)" es una petición muy directa y frecuente para la
  // que el modelo a veces no llama a ninguna herramienta (responde "no recibí
  // respuesta de las funciones..."). Se detecta aquí y se construye la lista
  // directamente, sin depender del modelo.
  const verboListar = "p[aá]sa(me)?|dame|env[ií]a(me)?|mu[eé]stra(me)?|ense[ñn]a(me)?|lista(r)?";
  const pideTodoGenerico =
    new RegExp(`(${verboListar})\\s+todo\\b`).test(msgLower) || /qu[eé]\s+tengo\b/.test(msgLower);
  const pideArchivos =
    new RegExp(`(${verboListar})\\s+(todos\\s+)?(mis\\s+)?(los\\s+)?(archivos?|ficheros?)\\b`).test(
      msgLower,
    ) || /qu[eé]\s+(archivos?|ficheros?)\s+tengo/.test(msgLower);
  const pideCarpetas =
    new RegExp(`(${verboListar})\\s+(todas\\s+)?(mis\\s+)?(las\\s+)?carpetas?\\b`).test(msgLower) ||
    /qu[eé]\s+carpetas?\s+tengo/.test(msgLower);
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

  if (esListarAmbos || esListarSoloArchivos || esListarSoloCarpetas) {
    const partes: string[] = [];
    if (esListarAmbos || esListarSoloCarpetas) {
      const todas = await listarTodasCarpetas(usuarioId);
      const carpetas = soloRaiz ? todas.filter((c) => !c.ruta.slice(1).includes("/")) : todas;
      partes.push(
        carpetas.length
          ? `**Carpetas** (${carpetas.length}):\n${carpetas.map((c) => `- ${c.ruta}`).join("\n")}`
          : `No tienes ninguna carpeta${soloRaiz ? " en la raíz" : ""}.`,
      );
    }
    if (esListarAmbos || esListarSoloArchivos) {
      const { archivos, total } = await listarArchivos(usuarioId, soloRaiz ? "/" : undefined, 1, 200);
      const extra =
        !soloRaiz && total > archivos.length
          ? `\n\n(mostrando los ${archivos.length} más recientes de ${total})`
          : "";
      partes.push(
        archivos.length
          ? `**Archivos** (${soloRaiz ? archivos.length : total}):\n${archivos
              .map((a) => `- ${a.nombre}${!soloRaiz && a.carpeta !== "/" ? ` (${a.carpeta})` : ""}`)
              .join("\n")}${extra}`
          : `No tienes ningún archivo${soloRaiz ? " en la raíz" : ""}.`,
      );
    }
    return { respuesta: partes.join("\n\n"), acciones };
  }

  const MAX_ITER = 15;

  for (let i = 0; i < MAX_ITER; i++) {
    const respuesta = await llamarOllama(messages);
    messages.push(respuesta);

    let toolCalls = respuesta.tool_calls ?? [];
    // Respaldo: si el modelo no usó el campo tool_calls pero escribió las
    // llamadas como texto JSON en content, las extraemos y ejecutamos.
    if (toolCalls.length === 0 && respuesta.content) {
      toolCalls = extraerToolCallsDeTexto(respuesta.content);
    }
    if (toolCalls.length === 0) {
      return { respuesta: respuesta.content || "Hecho.", acciones };
    }

    // Resúmenes preconstruidos (markdown listo para mostrar directamente)
    const resumenes: string[] = [];

    for (const tc of toolCalls) {
      const args =
        typeof tc.function.arguments === "string"
          ? (JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>)
          : tc.function.arguments;
      const resultado = await ejecutarTool(tc.function.name, args, usuarioId, acciones);
      messages.push({ role: "tool", content: JSON.stringify(resultado) });

      // Cualquier herramienta que devuelva un "resumen" (facturas, ventas_top,
      // totales_facturas) trae el markdown ya formateado con € server-side.
      const r = resultado as Record<string, unknown>;
      if (typeof r.resumen === "string") {
        resumenes.push(r.resumen);
      }
    }

    // Si TODAS las llamadas de esta iteración tienen resumen preconstruido, devolver
    // directamente sin otro turno del modelo (evita que reformatee mal o invente cosas).
    if (resumenes.length === toolCalls.length && resumenes.length > 0) {
      return { respuesta: [...new Set(resumenes)].join("\n\n---\n\n"), acciones };
    }
  }

  // Si se agotaron las iteraciones, pedir una respuesta final sin herramientas.
  const ultima = messages[messages.length - 1];
  return { respuesta: ultima.content || "He realizado las acciones solicitadas.", acciones };
};
