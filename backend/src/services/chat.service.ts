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
  asegurarFacturasEscaneadas,
  rankingMd,
  totalesMd,
  clientesTopMd,
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

// Quita tildes (á→a, é→e...) para que los pre-flights de intención reconozcan
// verbos con pronombre enclítico pegado ("bórralo", "elimínala", "vacíalas"),
// que desplazan el acento y no casan con los patrones normales ni con \b
// (no hay límite de palabra entre "borra" y "lo" en "borralo").
const quitarTildes = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

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

const SYSTEM_PROMPT = `Eres el asistente de AKX Cloud, una app de almacenamiento de archivos.
Gestionas los archivos y carpetas del usuario USANDO SIEMPRE las herramientas; nunca respondas de memoria ni inventes.

Si el mensaje es solo conversación (saludo, "qué tal", "gracias", charla trivial sin relación con archivos/carpetas/facturas), responde de forma natural, breve y amable, SIN llamar a ninguna herramienta: ese caso no necesita datos reales, así que la regla de basarte solo en herramientas no aplica.

Cómo actuar:
- Las acciones sobre archivos (copiar/mover/renombrar/borrar) se hacen indicando el NOMBRE del archivo; el sistema lo localiza solo. No necesitas ids.
- Si quieres ver qué hay, usa "buscar_archivos" (con "texto" para filtrar por nombre, o "carpeta" para listar una carpeta; sin nada lista los más recientes).
- Para crear una carpeta usa "crear_carpeta" con la "ruta" (ej: "/facturas"). Si el usuario NO indica dónde (solo da un nombre, ej: "creame una carpeta demo"), la ruta es simplemente "/<nombre>" en la RAÍZ; no inventes ni anides una ubicación a partir de carpetas mencionadas antes en la conversación. Para listarlas, "listar_carpetas". NUNCA llames a "crear_carpeta" como paso previo a "renombrar_carpeta", "mover_carpeta" ni ninguna otra operación: si el usuario menciona una carpeta, asume que ya existe y actúa directamente.
- Para crear un archivo/nota/documento (.md o .txt) DEBES llamar a "crear_archivo" (nombre, carpeta y contenido). Nunca describas que lo creas sin llamar a la herramienta. Si el usuario NO indica carpeta, NO pongas "carpeta" (se creará en la raíz); no te inventes una carpeta a partir del nombre.
- "eliminar_carpeta" borra la carpeta ENTERA (carpeta + contenido). "vaciar_carpeta" borra SOLO el contenido y deja la carpeta: úsalo si piden "borra el contenido de X" o "vacía X".
- Si el usuario pide borrar TODAS las carpetas (ej: "borra todas las carpetas"), usa "borrar_todas_carpetas": borra las carpetas Y su contenido (a la papelera), pero NO toca los archivos que ya estaban en la raíz. Si pide borrar TODOS los archivos/ficheros (ej: "borra todos los ficheros") sin mencionar carpetas, usa "borrar_todos_archivos": borra todos los archivos pero deja las carpetas (ahora vacías). Si pide borrar/vaciar TODO (absolutamente todo, incluida la raíz) o "empezar de cero", usa "borrar_todo".
- Para mover/renombrar/copiar/eliminar/vaciar una carpeta que YA EXISTE, indica solo su NOMBRE (ej: "tmp"); el sistema la localiza igual que con archivos, sin necesidad de la ruta completa. Solo da la ruta completa (ej: "/proyectos/tmp") si quieres ser explícito o si hay varias carpetas con el mismo nombre y te piden aclarar. La ruta completa SÍ es obligatoria al CREAR una carpeta nueva (no existe nada que localizar) y al indicar el destino de un mover/copiar.
- Para listar carpetas usa "listar_carpetas" (devuelve TODAS, incluidas las que tienen archivos).
- Papelera: "listar_papelera", "restaurar_archivo" (recuperar uno), "restaurar_todo" (recuperar TODOS los de la papelera de golpe), "borrar_permanente" (definitivo, irreversible, uno) y "vaciar_papelera" (definitivo, irreversible, TODOS). OJO: "borra/elimina X de la papelera" significa BORRAR DEFINITIVAMENTE ese archivo (usa "borrar_permanente"), NO recuperarlo. Solo uses "restaurar_archivo"/"restaurar_todo" si el usuario dice explícitamente "restaura"/"recupera"/"saca X de la papelera". "restaurar_todo" y "vaciar_papelera" son ACCIONES OPUESTAS (recuperar vs. borrar para siempre) — NUNCA uses una cuando piden la otra.
- Para responder sobre el contenido de un archivo CONCRETO (sabes su nombre) usa "leer_archivo" — esto incluye "abre X"/"ábreme X": en este chat "abrir" un archivo significa lo mismo que "leer/mostrar" su contenido, NUNCA dejes de llamar a la herramienta ni respondas que no puedes abrir archivos. Si el usuario solo pide "lee/muestra/abre/qué contiene X" sin una pregunta concreta sobre ese contenido, MUESTRA el contenido devuelto tal cual (no digas solo "lo he leído"). Para cifras de uso, "estadisticas".
- Para preguntas sobre el CONTENIDO sin saber en qué archivo está (ej: "¿qué documento habla de X?", "¿dónde dice algo sobre Y?", "resume lo que tengo sobre Z") usa "buscar_semantica": busca por significado dentro de todos los documentos y devuelve los más relevantes con un fragmento. Responde basándote en esos fragmentos y di de qué archivo salen.
- Una factura es un ARCHIVO normal (un PDF/imagen). Para copiarla/moverla/renombrarla/eliminarla usa SIEMPRE "copiar_archivo"/"mover_archivo"/"renombrar_archivo"/"eliminar_archivo" con su nombre — NO existen herramientas como "mover_factura" ni similares; nunca te inventes nombres de herramienta que no estén en la lista.
- FACTURAS — elige la herramienta correcta:
  • Si solo pregunta si EXISTE/TIENE un archivo (ej: "¿tengo un archivo llamado factura_01?", "busca factura_033") → usa "buscar_archivos", igual que con cualquier otro archivo. NUNCA escanees ni abras una factura solo para comprobar que existe (el OCR tarda mucho y aquí no hace falta).
  • Si el usuario pide VER o RESUMIR una factura específica YA escaneada → usa "obtener_factura" (lee de BD, rápido, sin re-procesar el PDF).
  • Si el usuario pide ESCANEAR/PROCESAR una o varias facturas concretas por nombre → usa "escanear_factura" UNA VEZ POR CADA archivo mencionado (nunca uses "escanear_todas_facturas" si el usuario nombró archivos específicos).
  • Si el usuario pide escanear/procesar TODAS sus facturas sin nombrarlas → usa "escanear_todas_facturas".
- ANALÍTICA DE FACTURAS — llama a la herramienta INMEDIATAMENTE, sin preguntar:
  • Rankings de productos o buscar un producto ("qué vendí más", "lo más/menos vendido", "ranking", "cuánto he vendido de X") → "ventas_top".
  • Totales facturados ("cuánto he facturado", "total gastado", "cuánto le he facturado a X") → "totales_facturas".
  • Ranking de CLIENTES por gasto ("qué cliente gastó más", "top clientes", "mi mejor cliente", "quién me ha comprado menos") → "clientes_top".
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
      name: "restaurar_todo",
      description:
        "Recupera TODOS los archivos de la papelera de una vez (no borra nada). Úsalo cuando pidan 'restaura/recupera todos los archivos/ficheros' o 'restaura toda la papelera'. NUNCA confundas esto con 'vaciar_papelera', que es justo lo opuesto (borrado definitivo).",
      parameters: { type: "object", properties: {} },
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
      description:
        "Borra DEFINITIVAMENTE todos los archivos de la papelera (no se puede deshacer). Úsalo SOLO si piden explícitamente 'vaciar/borrar definitivamente la papelera'. NUNCA lo uses para 'restaurar todos los archivos' — eso es 'restaurar_todo', la acción contraria.",
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
        "Lee y devuelve el contenido de un archivo (texto, PDF, DOCX o imagen) por su nombre. Úsalo SIEMPRE que el usuario pregunte qué dice / qué pone / qué contiene un archivo, o pida resumirlo o leerlo. NO pidas el contenido al usuario.",
      parameters: {
        type: "object",
        properties: {
          nombre: {
            type: "string",
            description:
              "nombre del archivo. Si el usuario no dio la extensión, pasa el nombre TAL CUAL, sin inventarte una (NO añadas .md ni ninguna otra).",
          },
        },
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
  {
    type: "function",
    function: {
      name: "clientes_top",
      description:
        "Ranking de CLIENTES por gasto total (importe facturado y nº de facturas). Úsala cuando pregunten qué cliente ha gastado más/menos, el top de clientes, o quién es el mejor cliente. TODOS los filtros son OPCIONALES: úsalos solo si el usuario los menciona.",
      parameters: {
        type: "object",
        properties: {
          emisor: { type: "string", description: "filtrar por emisor/proveedor (quién emite)" },
          orden: { type: "string", enum: ["mas", "menos"], description: "'mas' = quién más gastó (defecto), 'menos' = quién menos" },
          mes: { type: "number", description: "mes 1-12, solo si lo especifica" },
          anio: { type: "number", description: "año, solo si lo especifica" },
          desde: { type: "string", description: "fecha inicio YYYY-MM-DD (opcional)" },
          hasta: { type: "string", description: "fecha fin YYYY-MM-DD (opcional)" },
          limite: { type: "number", description: "cuántos clientes devolver (defecto 10)" },
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
  let lista = await buscarArchivos(usuarioId, nombre);
  if (lista.length === 0) {
    // El modelo a veces adivina una extensión que no es la real (ej. pide
    // "X.md" para preguntar "qué dice X" sin que el usuario diera extensión,
    // y el archivo real es "X.pdf"): la búsqueda por substring falla del todo
    // por la extensión aunque el nombre base sí exista. Reintenta sin ella.
    const sinExtension = nombre.replace(/\.[a-z0-9]{1,5}$/i, "");
    if (sinExtension !== nombre) lista = await buscarArchivos(usuarioId, sinExtension);
  }
  if (lista.length === 0) return { error: `No encontré ningún archivo que coincida con "${nombre}".` };
  const exacto = lista.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase());
  if (exacto) return { archivo: exacto };
  if (lista.length === 1) return { archivo: lista[0] };
  // El .md de resumen que se genera automáticamente al escanear una factura
  // (resumen-factura-X.md, en /facturas) coincide con casi cualquier búsqueda
  // por el número o nombre de esa factura, generando una ambigüedad constante
  // con el archivo real. Se descarta de los candidatos salvo que sea la única
  // coincidencia (pedirlo por su nombre completo ya se resuelve arriba, y
  // listar la carpeta entera no pasa por aquí, así que sigue mostrándolo).
  const sinResumenes = lista.filter((a) => !/^resumen-factura-/i.test(a.nombre));
  if (sinResumenes.length === 1) return { archivo: sinResumenes[0] };
  const final = sinResumenes.length > 0 ? sinResumenes : lista;
  return { opciones: final.map((a) => ({ nombre: a.nombre, carpeta: a.carpeta })) };
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
): Promise<{ ruta?: string; error?: string; opciones?: string[] }> => {
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

// Tipo de las opciones que se ofrecen al pedir aclaración: objeto (archivo,
// con nombre+carpeta) cuando viene de resolverArchivo/resolverEnPapelera, o
// string (ruta completa) cuando viene de resolverCarpeta.
type OpcionAclaracion = { nombre: string; carpeta: string } | string;

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
) => {
  pendientesAclaracion.set(usuarioId, { tool, args, clave, opciones, ts: Date.now() });
  return { necesita_aclaracion: true, opciones };
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
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
        const r = await copiarArchivo(res.archivo!.id, usuarioId, {
          carpeta: extraerRuta(args, "carpeta", "carpeta_destino", "destino", "ruta"),
        });
        acciones.push(`Copiado "${r.nombre}" en ${r.carpeta}`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "mover_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
        const carpetaArg = extraerRuta(args, "carpeta", "carpeta_destino", "destino", "ruta");
        if (!carpetaArg) return { error: "Falta indicar la carpeta destino." };
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, { carpeta: carpetaArg });
        acciones.push(`Movido "${r.nombre}" a ${r.carpeta}`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "renombrar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
        const r = await actualizarArchivo(res.archivo!.id, usuarioId, {
          nombre: String(args.nuevo_nombre),
        });
        acciones.push(`Renombrado a "${r.nombre}"`);
        return { ok: true, nombre: r.nombre, resumen: "Hecho." };
      }
      case "eliminar_archivo": {
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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
            return registrarAclaracion(usuarioId, "eliminar_archivo", {}, "nombre", comoArchivo.opciones);
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones);
        const r = await eliminarCarpetaConContenido(usuarioId, res.ruta!);
        acciones.push(`Carpeta enviada a la papelera: ${res.ruta} (${r.borrados} archivo/s)`);
        return { ok: true, borrados: r.borrados, resumen: "Hecho." };
      }
      case "vaciar_carpeta": {
        const rutaArg = extraerRuta(args);
        if (!rutaArg) return { error: "Falta indicar la ruta de la carpeta a vaciar." };
        const res = await resolverCarpeta(usuarioId, rutaArg);
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones);
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
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones);
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
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones);
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
            );
          return { error: res.error };
        }
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "ruta", res.opciones);
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
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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
        const res = await resolverArchivo(usuarioId, String(args.nombre));
        if (res.error) return { error: res.error };
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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
        if (res.opciones) return registrarAclaracion(usuarioId, nombre, args, "nombre", res.opciones);
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

// Llama a Ollama /api/chat (sin streaming).
const llamarOllama = async (
  messages: OllamaMessage[],
  sinHerramientas = false,
): Promise<OllamaMessage> => {
  let res: Response;
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
): Promise<{
  respuesta: string;
  acciones: string[];
  archivo?: { id: string; nombre: string };
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
  // Si una tool resuelve un archivo concreto (ej. obtener_factura), se guarda
  // aquí para que el front pueda ofrecer un botón "Abrir archivo" (abrir una
  // pestaña nueva desde el chat sin botón propio choca con el bloqueo de
  // pop-ups del navegador).
  let archivoParaAbrir: { id: string; nombre: string } | undefined;

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
      const candidatos = pendiente.opciones.filter((o) => {
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
          const lista = (resultado.opciones as unknown[])
            .map((o) =>
              typeof o === "string"
                ? `- ${o}`
                : `- ${(o as { nombre: string }).nombre}${
                    (o as { carpeta: string }).carpeta !== "/" ? ` (${(o as { carpeta: string }).carpeta})` : ""
                  }`,
            )
            .join("\n");
          return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista}`, acciones };
        }
        if (typeof resultado.error === "string") return { respuesta: resultado.error, acciones };
        if (typeof resultado.resumen === "string") {
          return {
            respuesta: resultado.resumen,
            acciones,
            archivo:
              typeof resultado.archivoId === "string" && typeof resultado.archivoNombre === "string"
                ? { id: resultado.archivoId, nombre: resultado.archivoNombre }
                : undefined,
          };
        }
        return { respuesta: "Hecho.", acciones };
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

  // Pre-flight: "¿qué hay en la papelera?" es una consulta directa y frecuente
  // que el modelo a veces desvía hacia herramientas de facturas (el prompt de
  // facturas es grande y le hace sesgo), devolviendo contenido random no
  // relacionado. Se resuelve aquí sin pasar por el modelo.
  const esListarPapelera =
    /papelera/.test(msgLower) &&
    /(qu[eé]\s+hay|lista(r)?|dame|mu[eé]stra(me)?|ense[ñn]a(me)?|p[aá]sa(me)?|ver)/.test(msgLower) &&
    !/borra|elimina|restaura|recupera|vacia/.test(msgSinTildes);
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
        const lista = res.opciones
          .map((o) => `- ${o.nombre}${o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`)
          .join("\n");
        return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista}`, acciones };
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
  const matchNombreFactura = msgLower.match(/\bfactura[\w.-]*\b/);
  const esAbrirFactura =
    tieneIntencionAbrirFactura &&
    !!matchNombreFactura &&
    !new RegExp(VERBO_BORRAR + "|" + VERBO_OTRAS_ACCIONES).test(msgSinTildes);
  if (esAbrirFactura && matchNombreFactura) {
    const res = await resolverArchivo(usuarioId, matchNombreFactura[0]);
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "obtener_factura", {}, "nombre", res.opciones);
      const lista = res.opciones
        .map((o) => `- ${o.nombre}${o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`)
        .join("\n");
      return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista}`, acciones };
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
      archivo: { id: res.archivo!.id, nombre: res.archivo!.nombre },
    };
  }

  // Pre-flight: "totales/total facturado de factura_X y factura_Y" (sin un verbo
  // claro como "dame"/"cuánto") a veces hace que el modelo interprete el primer
  // identificador como "abrir esa factura" en vez de pedir el total combinado de
  // todas las nombradas. Si se mencionan 2+ identificadores de factura junto a
  // "total(es)"/"facturado", se resuelve aquí directamente con "totales_facturas".
  const pideTotales = /\btotal(es)?\b/.test(msgLower) || /\bfacturado\b/.test(msgLower);
  const nombresFactura = [...msgLower.matchAll(/\bfactura[\w.-]*\b/g)].map((m) => m[0]);
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
    const MESES: Record<string, number> = {
      enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
      julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
      noviembre: 11, diciembre: 12,
    };
    let mes: number | undefined;
    for (const [nombreMes, num] of Object.entries(MESES)) {
      if (new RegExp(`\\b${nombreMes}\\b`).test(msgSinTildes)) {
        mes = num;
        break;
      }
    }
    const anioMatch = msgSinTildes.match(/\b(20\d{2})\b/);
    const orden = /\bmenos\b/.test(msgSinTildes) ? "menos" : "mas";
    const args: Record<string, unknown> = { orden };
    if (mes) args.mes = mes;
    if (anioMatch) args.anio = Number(anioMatch[1]);
    const resultado = (await ejecutarTool("ventas_top", args, usuarioId, acciones)) as Record<
      string,
      unknown
    >;
    if (typeof resultado.resumen === "string") return { respuesta: resultado.resumen, acciones };
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
    return { respuesta: `Sí, tienes:\n\n${detalle}`, acciones };
  }

  // Pre-flight: "lee/muestra/qué dice X" SIN nada más en el mensaje (solo verbo +
  // nombre, anclado al final). El modelo a veces solo confirma "lo he leído" en
  // vez de mostrar el contenido cuando este es muy corto/trivial, pese a la
  // instrucción explícita del prompt — se resuelve aquí leyendo de verdad y
  // devolviendo el contenido tal cual, sin pasar por el modelo. Si el mensaje
  // tiene algo más (una pregunta concreta sobre el contenido, ej. "qué dice el
  // contrato sobre los plazos"), el ancla `$` no casa y sigue el flujo normal.
  const matchLeerSimple = msgSinTildes.match(
    new RegExp(
      `^(?:lee(?:me)?|muestra(?:me)?(?:lo|la|los|las)?|ensena(?:me)?(?:lo|la|los|las)?|que\\s+dice)\\s+(?:el\\s+archivo\\s+|la\\s+nota\\s+|el\\s+documento\\s+)?["']?([\\wÀ-ÿ.-]+)["']?\\s*\\??\\s*$`,
    ),
  );
  if (matchLeerSimple) {
    const res = await resolverArchivo(usuarioId, grupoOriginal(msgLower, matchLeerSimple));
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "leer_archivo", {}, "nombre", res.opciones);
      const lista2 = res.opciones
        .map((o) => `- ${o.nombre}${o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`)
        .join("\n");
      return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista2}`, acciones };
    }
    try {
      const contenido = await leerTextoArchivo(res.archivo!.id, usuarioId);
      return { respuesta: `**${res.archivo!.nombre}**:\n\n${contenido}`, acciones };
    } catch (err) {
      return {
        respuesta: err instanceof AppError ? err.message : "No pude leer el contenido del archivo.",
        acciones,
      };
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
  // Palabras sueltas que NO deben tratarse como nombre de archivo si aparecen
  // justo tras el verbo (ej. "borra mi reporte", "borra eso de antes").
  const STOPWORDS_BORRAR = new Set([
    "mi", "tu", "su", "lo", "la", "el", "los", "las", "eso", "esto", "esta",
    "este", "todo", "toda", "algo", "uno", "una", "ese", "esa",
  ]);
  const matchNombreArchivoABorrar =
    msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b.*?(?:archivo|fichero)\\s+(?:llamado\\s+)?["']?([\\wÀ-ÿ.-]+)`)) ||
    msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b\\s+["']?([\\wÀ-ÿ-]+\\.[a-z0-9]{1,5})\\b`)) ||
    (() => {
      // Sin extensión ni la palabra "archivo" (ej. "borra factura_F2026-101"):
      // solo se acepta si NO es una palabra suelta de la lista de arriba.
      const m = msgSinTildes.match(new RegExp(`\\b${VERBO_BORRAR}\\b\\s+["']?([\\wÀ-ÿ-]{4,})\\b`));
      return m && !STOPWORDS_BORRAR.has(m[1]!) ? m : null;
    })();
  const esBorrarUnArchivo = !!matchNombreArchivoABorrar && !/carpeta|papelera/.test(msgSinTildes);
  if (esBorrarUnArchivo && matchNombreArchivoABorrar) {
    const res = await resolverArchivo(usuarioId, grupoOriginal(msgLower, matchNombreArchivoABorrar));
    if (res.error) return { respuesta: res.error, acciones };
    if (res.opciones) {
      registrarAclaracion(usuarioId, "eliminar_archivo", {}, "nombre", res.opciones);
      const lista = res.opciones
        .map((o) => `- ${o.nombre}${o.carpeta !== "/" ? ` (${o.carpeta})` : ""}`)
        .join("\n");
      return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista}`, acciones };
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
      registrarAclaracion(usuarioId, "eliminar_carpeta", {}, "ruta", res.opciones);
      const lista = res.opciones.map((o) => `- ${o}`).join("\n");
      return { respuesta: `Hay varias carpetas con ese nombre, ¿cuál quieres?\n\n${lista}`, acciones };
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
  const pideTodoGenerico =
    new RegExp(`(${VERBO_LISTAR})\\s+todo\\b`).test(msgSinTildes) ||
    /qu[eé]\s+tengo\b(?!\s+(sobre|de|acerca|relacionado))/.test(msgLower);
  const pideArchivos =
    new RegExp(`(${VERBO_LISTAR})\\s+(todos\\s+)?(mis\\s+)?(los\\s+)?(archivos?|ficheros?)\\b`).test(
      msgSinTildes,
    ) || /qu[eé]\s+(archivos?|ficheros?)\s+tengo/.test(msgLower);
  const pideCarpetas =
    new RegExp(`(${VERBO_LISTAR})\\s+(todas\\s+)?(mis\\s+)?(las\\s+)?carpetas?\\b`).test(msgSinTildes) ||
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
      return {
        respuesta: `Hay varias carpetas con ese nombre, ¿cuál quieres?\n\n${res.opciones
          .map((o) => `- ${o}`)
          .join("\n")}`,
        acciones,
      };
    }
    const ruta = res.ruta!;
    const partes: string[] = [];
    if (esListarAmbos || esListarSoloCarpetas) {
      const sub = (await listarTodasCarpetas(usuarioId)).filter((c) => c.ruta.startsWith(`${ruta}/`));
      partes.push(
        sub.length
          ? `**Carpetas dentro de ${ruta}** (${sub.length}):\n${sub.map((c) => `- ${c.ruta}`).join("\n")}`
          : `No hay carpetas dentro de ${ruta}.`,
      );
    }
    if (esListarAmbos || esListarSoloArchivos) {
      const { archivos } = await listarArchivos(usuarioId, ruta, 1, 200);
      partes.push(
        archivos.length
          ? `**Archivos dentro de ${ruta}** (${archivos.length}):\n${archivos
              .map((a) => `- ${a.nombre}`)
              .join("\n")}`
          : `No hay archivos dentro de ${ruta}.`,
      );
    }
    return { respuesta: partes.join("\n\n"), acciones };
  }

  if (esListado) {
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
      if (respuesta.content && pareceIntentoToolCallInvalido(respuesta.content)) {
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
        const lista = (r.opciones as unknown[])
          .map((o) => {
            if (typeof o === "string") return `- ${o}`;
            const obj = o as { nombre?: string; carpeta?: string };
            return `- ${obj.nombre}${obj.carpeta && obj.carpeta !== "/" ? ` (${obj.carpeta})` : ""}`;
          })
          .join("\n");
        return { respuesta: `Hay varias coincidencias, ¿cuál quieres?\n\n${lista}`, acciones };
      }

      // Cualquier herramienta que devuelva un "resumen" (facturas, ventas_top,
      // totales_facturas) trae el markdown ya formateado con € server-side.
      if (typeof r.resumen === "string") {
        resumenes.push(r.resumen);
      }

      if (typeof r.archivoId === "string" && typeof r.archivoNombre === "string") {
        archivoParaAbrir = { id: r.archivoId, nombre: r.archivoNombre };
      }
    }

    // Si TODAS las llamadas de esta iteración tienen resumen preconstruido, devolver
    // directamente sin otro turno del modelo (evita que reformatee mal o invente cosas).
    if (resumenes.length === toolCalls.length && resumenes.length > 0) {
      return {
        respuesta: [...new Set(resumenes)].join("\n\n---\n\n"),
        acciones,
        archivo: archivoParaAbrir,
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
      return { respuesta: final.content || "He realizado las acciones solicitadas.", acciones, archivo: archivoParaAbrir };
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
  return { respuesta: final.content || "He realizado las acciones solicitadas.", acciones };
};
