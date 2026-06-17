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
  leerTextoArchivo,
  estadisticasUsuario,
} from "./archivos.service";
import {
  crearCarpeta,
  listarTodasCarpetas,
  eliminarCarpetaConContenido,
  vaciarCarpeta,
  vaciarTodo,
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
- Para crear una carpeta usa "crear_carpeta" con la "ruta" (ej: "/facturas"). Para listarlas, "listar_carpetas". NUNCA llames a "crear_carpeta" como paso previo a "renombrar_carpeta", "mover_carpeta" ni ninguna otra operación: si el usuario menciona una carpeta, asume que ya existe y actúa directamente.
- Para crear un archivo/nota/documento (.md o .txt) DEBES llamar a "crear_archivo" (nombre, carpeta y contenido). Nunca describas que lo creas sin llamar a la herramienta. Si el usuario NO indica carpeta, NO pongas "carpeta" (se creará en la raíz); no te inventes una carpeta a partir del nombre.
- "eliminar_carpeta" borra la carpeta ENTERA (carpeta + contenido). "vaciar_carpeta" borra SOLO el contenido y deja la carpeta: úsalo si piden "borra el contenido de X" o "vacía X".
- Si el usuario pide borrar TODAS las carpetas (aunque no mencione archivos), usa "borrar_todo" directamente.
- Para mover/renombrar/copiar carpetas usa "mover_carpeta"/"renombrar_carpeta"/"copiar_carpeta".
- Para listar carpetas usa "listar_carpetas" (devuelve TODAS, incluidas las que tienen archivos).
- Papelera: "listar_papelera", "restaurar_archivo", "borrar_permanente" (definitivo) y "vaciar_papelera".
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
      description: "Crea una carpeta. Indica la ruta completa, ej: /facturas o /facturas/2026.",
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
        "Vacía el CONTENIDO de una carpeta (envía sus archivos a la papelera) pero MANTIENE la carpeta. Úsalo cuando pidan 'borra el contenido de la carpeta X' o 'vacía la carpeta X'.",
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
        "Borra TODO: envía a la papelera todos los archivos del usuario y elimina todas sus carpetas. Úsalo cuando el usuario pida borrar/vaciar todo, empezar de cero, o borrar TODAS las carpetas (con o sin archivos). Los archivos quedan recuperables desde la papelera.",
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
      description: "Restaura un archivo de la papelera (por su nombre).",
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
      description: "Borra DEFINITIVAMENTE un archivo de la papelera (no se puede deshacer).",
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
        return { ok: true, nombre: r.nombre };
      }
      case "mover_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          carpeta: String(args.carpeta),
        });
        acciones.push(`Movido "${r.nombre}" a ${args.carpeta}`);
        return { ok: true, nombre: r.nombre };
      }
      case "renombrar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          nombre: String(args.nuevo_nombre),
        });
        acciones.push(`Renombrado a "${r.nombre}"`);
        return { ok: true, nombre: r.nombre };
      }
      case "eliminar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        await eliminarArchivo(res.archivo!.id, usuarioId);
        acciones.push(`Enviado a la papelera "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre };
      }
      case "crear_carpeta": {
        const ruta = await crearCarpeta(usuarioId, String(args.ruta));
        acciones.push(`Carpeta creada: ${ruta}`);
        return { ok: true, ruta };
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
        return { ok: true, nombre: r.nombre, carpeta: r.carpeta };
      }
      case "eliminar_carpeta": {
        const r = await eliminarCarpetaConContenido(usuarioId, String(args.ruta));
        acciones.push(`Carpeta enviada a la papelera: ${args.ruta} (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados };
      }
      case "vaciar_carpeta": {
        const r = await vaciarCarpeta(usuarioId, String(args.ruta));
        acciones.push(`Contenido de ${args.ruta} enviado a la papelera (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados };
      }
      case "listar_carpetas": {
        return await listarTodasCarpetas(usuarioId);
      }
      case "borrar_todo": {
        const r = await vaciarTodo(usuarioId);
        acciones.push(
          `Borrado todo: ${r.archivos} archivo/s a la papelera y ${r.carpetas} carpeta/s eliminada/s`,
        );
        return { ok: true, archivos: r.archivos, carpetas: r.carpetas };
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
        return { ok: true, nombre: res.archivo!.nombre };
      }
      case "borrar_permanente": {
        const res = await resolverEnPapelera(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return { necesita_aclaracion: true, opciones: res.opciones };
        await borrarPermanente(res.archivo!.id, usuarioId);
        acciones.push(`Borrado definitivamente "${res.archivo!.nombre}"`);
        return { ok: true, nombre: res.archivo!.nombre };
      }
      case "vaciar_papelera": {
        const r = await vaciarPapelera(usuarioId);
        acciones.push(`Papelera vaciada (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados };
      }
      // --- Operaciones de carpeta ---
      case "mover_carpeta": {
        const origen = normalizarRuta(String(args.ruta));
        const destino = unirRuta(normalizarRuta(String(args.carpeta_destino)), hojaRuta(origen));
        const r = await moverCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta movida a ${destino} (${r.movidos} archivo/s)`);
        return { ok: true, destino, movidos: r.movidos };
      }
      case "renombrar_carpeta": {
        const origen = normalizarRuta(String(args.ruta));
        const destino = unirRuta(padreRuta(origen), String(args.nuevo_nombre));
        const r = await moverCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta renombrada a ${destino}`);
        return { ok: true, destino, movidos: r.movidos };
      }
      case "copiar_carpeta": {
        const origen = normalizarRuta(String(args.ruta));
        const destino =
          typeof args.carpeta_destino === "string" && args.carpeta_destino
            ? unirRuta(normalizarRuta(args.carpeta_destino), hojaRuta(origen))
            : unirRuta(padreRuta(origen), `${hojaRuta(origen)} (copia)`);
        const r = await copiarCarpetaConContenido(usuarioId, origen, destino);
        acciones.push(`Carpeta copiada a ${destino} (${r.copiados} archivo/s)`);
        return { ok: true, destino, copiados: r.copiados };
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
        const r = await escanearFactura(usuarioId, res.archivo!.id, pista);
        acciones.push(
          `Factura escaneada${r.numero ? ` (${r.numero})` : ""}: ${r.lineas} línea/s`,
        );
        return { ok: true, resumen: r.resumen, numero: r.numero, lineas: r.lineas };
      }
      case "ventas_top": {
        const { filtro, titulo } = filtroFacturasDesdeArgs(args);
        const orden: "asc" | "desc" = args.orden === "menos" ? "asc" : "desc";
        const limite = typeof args.limite === "number" ? args.limite : 10;
        const top = await ventasTop(usuarioId, filtro, { orden, limite });
        const prefijo = orden === "asc" ? "Productos menos vendidos" : "Productos más vendidos";
        return { resumen: rankingMd(top, `${prefijo} (${titulo})`) };
      }
      case "totales_facturas": {
        const { filtro, titulo } = filtroFacturasDesdeArgs(args);
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

  // Pre-flight: "borra todo / todas las carpetas / vacía todo / empezar de cero"
  // El modelo no llama borrar_todo de forma fiable para estas frases.
  const ultimoMensaje = mensajes[mensajes.length - 1]?.contenido ?? "";
  const msgLower = ultimoMensaje.toLowerCase();
  const esBorrarTodo =
    /borra(r)?\s+(todo|todas?\s+(las\s+)?carpetas?|todo\s+lo)|vac[ií]a(r)?\s+(todo|todas?\s+(las\s+)?carpetas?)|elimina(r)?\s+(todo|todas?\s+(las\s+)?carpetas?)|empeza(r)?\s+de\s+cero/.test(msgLower);

  if (esBorrarTodo) {
    const resultado = await ejecutarTool("borrar_todo", {}, usuarioId, acciones);
    const r = resultado as Record<string, unknown>;
    if (r.ok) {
      return { respuesta: "Hecho.", acciones };
    }
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
      return { respuesta: resumenes.join("\n\n---\n\n"), acciones };
    }
  }

  // Si se agotaron las iteraciones, pedir una respuesta final sin herramientas.
  const ultima = messages[messages.length - 1];
  return { respuesta: ultima.content || "He realizado las acciones solicitadas.", acciones };
};
