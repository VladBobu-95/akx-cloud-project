// Esquema de herramientas (function calling) y system prompt del chatbot.
// Datos declarativos (sin lógica), extraídos de chat.service.ts para aligerarlo.

export const SYSTEM_PROMPT = `Eres el asistente de AKX Cloud, una app de almacenamiento de archivos.
Gestionas los archivos y carpetas del usuario USANDO SIEMPRE las herramientas; nunca respondas de memoria ni inventes.

Si el mensaje es solo conversación (saludo, "qué tal", "gracias", charla trivial sin relación con archivos/carpetas/facturas), responde de forma natural, breve y amable, SIN llamar a ninguna herramienta: ese caso no necesita datos reales, así que la regla de basarte solo en herramientas no aplica.

Cómo actuar:
- Si el usuario te pide mover o copiar un archivo a una carpeta pero NO especifica el nombre de la carpeta de destino (ej: "copia factura_08 a la carpeta"), NO llames a la herramienta todavía. Responde directamente al usuario pidiéndole que aclare a qué carpeta específica quiere copiar o mover el archivo.
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
export const TOOLS = [
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
