import { randomUUID } from "crypto";
import { AppDataSource } from "../config/database";
import { poolChat } from "../config/chatDb";
import { env } from "../config/env";
import { campoThink, ollamaHeaders } from "../config/ollama";
import { Usuario } from "../entities/Usuario";
import { AppError } from "../utils/errors";
import { capacidadesDe } from "./equipo.service";
import { carpetasAccesibles } from "./compartido.service";

// ---------------------------------------------------------------------------
// Chat por SQL. Sin tools ni pre-flights: el modelo lee la BD escribiendo una
// consulta SELECT en un bloque ```sql, el backend la ejecuta con el rol de solo
// lectura "ateka_chat" (config/chatDb.ts) y le devuelve las filas; con ellas el
// modelo redacta la respuesta. Puede encadenar varias consultas (MAX_CONSULTAS).
//
// El chat es de SOLO LECTURA: mover, borrar, subir… se hace desde el explorador.
//
// Seguridad: el SQL del modelo no es de fiar (lo puede dirigir el usuario con su
// mensaje). La frontera está en la BD, no en este archivo: el rol ateka_chat solo
// ve las vistas del esquema "chat", y estas solo devuelven filas del usuario
// cuyo token de acceso (chat_accesos) está fijado en la sesión. Ver la migración
// 1779000000000-ChatSql.ts. Aquí solo se añade: una sola sentencia (protocolo
// extendido de pg), transacción de solo lectura y tope de filas.
// ---------------------------------------------------------------------------

export interface MensajeChat {
  rol: "usuario" | "bot";
  contenido: string;
}

// Resultado de la última consulta con varias filas: el front lo pinta como tabla
// debajo de la respuesta (y un botón "Abrir" si hay columna archivo_id).
export interface TablaChat {
  columnas: string[];
  filas: Valor[][];
  truncada: boolean; // había más filas que MAX_FILAS_TABLA
}

export interface RespuestaChat {
  respuesta: string;
  tabla?: TablaChat;
}

type Valor = string | number | boolean | null;

interface MensajeOllama {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ResultadoSql {
  columnas: string[];
  filas: Valor[][];
  truncada: boolean;
}

const MAX_CONSULTAS = 4; // consultas SQL por mensaje del usuario
const MAX_FILAS_TABLA = 200; // filas que se devuelven al front
// Los tres topes siguientes mantienen la conversación dentro de OLLAMA_NUM_CTX (8k):
// prompt ~1,5k tokens + historial ~2,5k + resultados de las consultas.
const MAX_FILAS_MODELO = 25; // filas que se le enseñan al modelo
const MAX_HISTORIAL = 8; // mensajes previos de la conversación que ve el modelo
const MAX_CHARS_MENSAJE = 1200;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const hoyMadrid = (): string =>
  new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());

interface ContextoUsuario {
  nombre: string;
  empresa: string | null;
  nif: string | null;
  puedeFacturas: boolean;
  puedeContenido: boolean;
}

const construirPrompt = (c: ContextoUsuario): string => {
  const esquemaFacturas = c.puedeFacturas
    ? `
chat.facturas — facturas escaneadas del usuario (no incluye las de archivos en la papelera)
  factura_id uuid, archivo_id uuid, archivo text (nombre del archivo),
  numero text, fecha date,
  tipo text: 'venta' (la emite la empresa del usuario), 'compra' (la recibe), 'desconocido' (sin clasificar),
  emisor text, emisor_nif text, cliente text, cliente_nif text,
  moneda text (ISO: EUR, USD…), subtotal numeric, iva numeric, total numeric

chat.lineas_factura — conceptos de cada factura
  factura_id uuid, descripcion text, cantidad numeric, precio_unitario numeric, total numeric`
    : "";

  const reglaFacturas = c.puedeFacturas
    ? `- Importes: NUNCA sumes monedas distintas; agrupa por moneda. Ventas = tipo 'venta', compras/gastos = tipo 'compra'. IVA repercutido = iva de ventas, soportado = iva de compras.`
    : `- El usuario NO tiene acceso a facturas: si pregunta por ellas, dile que no está disponible para su rol (sin consultar nada).`;

  const reglaContenido = c.puedeContenido
    ? `- Para buscar qué documento habla de algo: unaccent(contenido) ILIKE unaccent('%palabra%'). Para leer un documento: left(contenido, 2500) de ESE archivo. Nunca pidas el contenido completo de muchos archivos a la vez.`
    : `- El usuario NO puede leer el contenido de los documentos (la columna contenido viene vacía): si lo pide, dile que no está disponible para su rol.`;

  return `Eres el asistente de ATEKA Cloud, una app de almacenamiento de archivos y facturas de empresa.
Hablas con ${c.nombre}${c.empresa ? `, de la empresa "${c.empresa}"${c.nif ? ` (CIF ${c.nif})` : ""}` : ""}.
Hoy es ${hoyMadrid()}.

Tienes acceso de SOLO LECTURA a sus datos mediante PostgreSQL. Estas son TODAS las tablas que existen:

chat.archivos — archivos personales del usuario (incluida su papelera) y los de las carpetas compartidas a las que tiene acceso
  archivo_id uuid, nombre text,
  carpeta text (ruta, p. ej. '/facturas/2026'; '/' es la raíz),
  carpeta_compartida text (NULL = archivo personal; si no, nombre de la carpeta compartida),
  tipo_mime text, tamano_bytes bigint, subido_en timestamptz, modificado_en timestamptz,
  en_papelera boolean, eliminado_en timestamptz,
  contenido text (texto del documento: PDF, Word, OCR de imágenes y descripción manual),
  procesando boolean (true = recién subido, aún se está leyendo/escaneando)

chat.carpetas — carpetas creadas
  ruta text, carpeta_compartida text (NULL = personal), creada_en timestamptz

chat.carpetas_compartidas — carpetas compartidas a las que tiene acceso
  nombre text, creada_en timestamptz
${esquemaFacturas}

CÓMO RESPONDER
1. Si necesitas datos, responde ÚNICAMENTE con un bloque de código SQL, sin texto alrededor:
\`\`\`sql
SELECT ...
\`\`\`
   Recibirás el resultado y podrás hacer otra consulta si hace falta, o responder.
2. Cuando tengas los datos (o si no hacen falta, p. ej. un saludo), responde al usuario en español, en markdown, breve y claro.
   - Usa SOLO los datos de los resultados. No inventes nombres, cifras ni fechas. Si no hay resultados, dilo.
   - No menciones SQL, consultas, tablas ni columnas.
   - Si el resultado tiene varias filas, se mostrará como tabla debajo de tu respuesta: no las copies todas, resume (cuántas hay, totales, lo más destacado).
   - Importes en formato español: 1.234,56 €.
3. Solo puedes CONSULTAR. Si pide mover, copiar, renombrar, borrar, subir o restaurar algo, explícale que debe hacerlo desde "Mis archivos" (o "Papelera").
4. Si la pregunta es ambigua, pide que la concrete.
5. Si no encuentras una factura o un contenido y el archivo tiene procesando = true, dile que aún se está procesando y que pregunte de nuevo en unos segundos (no digas que no existe).

REGLAS SQL
- Una sola sentencia SELECT (o WITH … SELECT), siempre con el prefijo chat. en las tablas.
- Excluye la papelera (NOT en_papelera) salvo que pregunte por la papelera.
- Texto: compara sin distinguir mayúsculas ni tildes: unaccent(columna) ILIKE unaccent('%texto%').
- Carpeta X incluye sus subcarpetas: (carpeta = '/x' OR carpeta LIKE '/x/%').
- Al listar archivos o facturas incluye archivo_id (permite al usuario abrirlos) y un ORDER BY con sentido.
${reglaFacturas}
${reglaContenido}

EJEMPLOS
Usuario: ¿qué archivos tengo en proyectos?
\`\`\`sql
SELECT archivo_id, nombre, carpeta, tamano_bytes, subido_en FROM chat.archivos
WHERE NOT en_papelera AND carpeta_compartida IS NULL
  AND (unaccent(carpeta) ILIKE unaccent('/proyectos') OR unaccent(carpeta) ILIKE unaccent('/proyectos/%'))
ORDER BY carpeta, nombre
\`\`\`
${
  c.puedeFacturas
    ? `Usuario: ¿cuánto he facturado este trimestre?
\`\`\`sql
SELECT moneda, count(*) AS facturas, sum(subtotal) AS base, sum(iva) AS iva, sum(total) AS total
FROM chat.facturas
WHERE tipo = 'venta' AND fecha >= date_trunc('quarter', current_date)
GROUP BY moneda
\`\`\`
Usuario: mis 5 mejores clientes
\`\`\`sql
SELECT cliente, moneda, count(*) AS facturas, sum(total) AS total FROM chat.facturas
WHERE tipo = 'venta' GROUP BY cliente, moneda ORDER BY total DESC LIMIT 5
\`\`\`
`
    : ""
}${
  c.puedeContenido
    ? `Usuario: ¿qué documento habla de la garantía?
\`\`\`sql
SELECT archivo_id, nombre, carpeta, left(contenido, 300) AS extracto FROM chat.archivos
WHERE NOT en_papelera AND unaccent(contenido) ILIKE unaccent('%garantia%')
ORDER BY modificado_en DESC LIMIT 20
\`\`\`
`
    : ""
}`;
};

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

const llamarModelo = async (messages: MensajeOllama[]): Promise<string> => {
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        stream: false,
        ...(await campoThink(env.OLLAMA_MODEL, env.OLLAMA_THINK)),
        // Mismo num_ctx que la extracción de facturas: si difiere, Ollama
        // recarga el modelo al alternar entre chat y escaneo.
        options: { temperature: 0.2, num_ctx: env.OLLAMA_NUM_CTX },
        keep_alive: "30m",
      }),
      signal: AbortSignal.timeout(env.OLLAMA_TIMEOUT_MS),
    });
  } catch {
    throw new AppError(503, "El asistente no está disponible ahora mismo. Inténtalo en un momento.");
  }
  const data = (await res.json().catch(() => ({}))) as {
    message?: { content?: string };
    error?: string;
  };
  if (!res.ok || data.error) {
    console.error("[chat] error de Ollama:", data.error ?? res.status);
    throw new AppError(503, "El asistente no está disponible ahora mismo. Inténtalo en un momento.");
  }
  // Por si el modelo piensa en línea (sin el campo `thinking` separado).
  return (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
};

// Saca la consulta de la respuesta del modelo: el primer bloque ```sql, o la
// respuesta entera si es solo una sentencia SELECT/WITH sin el bloque.
export const extraerSql = (texto: string): string | null => {
  const bloque = /```(?:sql|postgresql|postgres)?\s*\n([\s\S]*?)```/i.exec(texto);
  const candidato = bloque ? bloque[1] : /^(select|with)\b/i.test(texto.trim()) ? texto : null;
  if (!candidato) return null;
  const sql = candidato.trim().replace(/;+\s*$/, "").trim();
  return sql || null;
};

// ---------------------------------------------------------------------------
// Ejecución del SQL del modelo
// ---------------------------------------------------------------------------

// Token de acceso de un solo uso que filtran las vistas del esquema chat.
// (Exportadas abrirAcceso/ejecutarSql/cerrarAcceso para los tests de la frontera.)
export const abrirAcceso = async (
  usuarioId: string,
  ctx: Pick<ContextoUsuario, "puedeFacturas" | "puedeContenido">,
): Promise<string> => {
  const token = randomUUID();
  const compartidas = (await carpetasAccesibles(usuarioId)).map((c) => c.id);
  await AppDataSource.query(`DELETE FROM "chat_accesos" WHERE "expiraEn" < now()`);
  await AppDataSource.query(
    `INSERT INTO "chat_accesos" ("token", "usuarioId", "compartidas", "puedeFacturas", "puedeContenido", "expiraEn")
     VALUES ($1, $2, $3::uuid[], $4, $5, now() + interval '5 minutes')`,
    [token, usuarioId, compartidas, ctx.puedeFacturas, ctx.puedeContenido],
  );
  return token;
};

export const cerrarAcceso = async (token: string): Promise<void> => {
  await AppDataSource.query(`DELETE FROM "chat_accesos" WHERE "token" = $1`, [token]).catch(
    () => {},
  );
};

const aValor = (v: unknown): Valor => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
};

export const ejecutarSql = async (token: string, sql: string): Promise<ResultadoSql> => {
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error("Solo se permiten consultas SELECT.");
  }
  const client = await poolChat().connect();
  let fallo: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.chat_token', $1, true)", [token]);
    // Con parámetros ($1) pg usa el protocolo extendido, que NO admite varias
    // sentencias: un "; DROP …" o un "RESET ROLE; …" colado en el SQL falla ahí.
    // Los saltos de línea evitan que un comentario "--" final se coma el cierre.
    const r = await client.query<Valor[]>({
      text: `SELECT * FROM (\n${sql}\n) AS consulta LIMIT $1`,
      values: [MAX_FILAS_TABLA + 1],
      rowMode: "array",
    });
    const truncada = r.rows.length > MAX_FILAS_TABLA;
    return {
      columnas: r.fields.map((f) => f.name),
      filas: r.rows.slice(0, MAX_FILAS_TABLA).map((fila) => fila.map(aValor)),
      truncada,
    };
  } catch (e) {
    fallo = e instanceof Error ? e : new Error(String(e));
    throw fallo;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    // Tras un timeout la conexión puede quedar a medias: se descarta.
    client.release(fallo && /timeout/i.test(fallo.message) ? fallo : undefined);
  }
};

// Resultado resumido para el modelo: filas como JSON (una por línea), con los
// textos largos recortados. Si hay pocas filas se deja más texto (leer un
// documento concreto); con muchas se recorta más para no llenar el contexto.
const resultadoParaModelo = (r: ResultadoSql): string => {
  if (r.filas.length === 0) return "La consulta no devolvió ninguna fila.";
  const maxTexto = r.filas.length <= 3 ? 2500 : 200;
  const lineas = r.filas.slice(0, MAX_FILAS_MODELO).map((fila) => {
    const obj: Record<string, Valor> = {};
    r.columnas.forEach((col, i) => {
      const v = fila[i];
      obj[col] = typeof v === "string" && v.length > maxTexto ? `${v.slice(0, maxTexto)}…` : v;
    });
    return JSON.stringify(obj);
  });
  const total = r.truncada ? `más de ${MAX_FILAS_TABLA}` : String(r.filas.length);
  const aviso =
    r.filas.length > MAX_FILAS_MODELO ? ` (se muestran las ${MAX_FILAS_MODELO} primeras)` : "";
  return `Filas: ${total}${aviso}\n${lineas.join("\n")}`;
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const cargarContexto = async (usuarioId: string, caps: Set<string>): Promise<ContextoUsuario> => {
  const usuario = await AppDataSource.getRepository(Usuario).findOne({
    where: { id: usuarioId },
    relations: { empresa: true },
  });
  return {
    nombre: usuario?.nombre || usuario?.email || "el usuario",
    empresa: usuario?.empresa?.nombre ?? null,
    nif: usuario?.empresa?.nif ?? null,
    puedeFacturas: caps.has("facturas"),
    puedeContenido: caps.has("busqueda"),
  };
};

const aHistorial = (mensajes: MensajeChat[]): MensajeOllama[] =>
  mensajes.slice(-MAX_HISTORIAL).map((m) => ({
    role: m.rol === "usuario" ? "user" : "assistant",
    content: m.contenido.slice(0, MAX_CHARS_MENSAJE),
  }));

export const chatear = async (usuarioId: string, mensajes: MensajeChat[]): Promise<RespuestaChat> => {
  // Capacidad maestra: sin "chat" no hay chatbot (el front además oculta la página).
  const caps = await capacidadesDe(usuarioId);
  if (!caps.has("chat")) {
    throw new AppError(403, "El asistente no está disponible para tu rol.");
  }
  const ultimo = mensajes[mensajes.length - 1];
  if (!ultimo || ultimo.rol !== "usuario" || !ultimo.contenido.trim()) {
    throw new AppError(400, "Falta el mensaje.");
  }

  const ctx = await cargarContexto(usuarioId, caps);
  const conversacion: MensajeOllama[] = [
    { role: "system", content: construirPrompt(ctx) },
    ...aHistorial(mensajes),
  ];

  const token = await abrirAcceso(usuarioId, ctx);
  let tabla: TablaChat | undefined;
  // Métricas para el log: cuánto tarda la respuesta y en qué (modelo vs. SQL).
  const inicio = Date.now();
  let msModelo = 0;
  let consultas = 0;
  try {
    for (let i = 0; i <= MAX_CONSULTAS; i++) {
      const ultimaVuelta = i === MAX_CONSULTAS;
      if (ultimaVuelta) {
        conversacion.push({
          role: "user",
          content: "Ya no puedes hacer más consultas. Responde al usuario con los datos que tienes.",
        });
      }
      const t0 = Date.now();
      const salida = await llamarModelo(conversacion);
      msModelo += Date.now() - t0;
      const sql = ultimaVuelta ? null : extraerSql(salida);

      if (!sql) {
        console.log(
          `[chat] respuesta en ${((Date.now() - inicio) / 1000).toFixed(1)} s ` +
            `(${i + 1} llamadas al modelo: ${(msModelo / 1000).toFixed(1)} s, ${consultas} consultas SQL)`,
        );
        const respuesta = salida.replace(/```[\s\S]*?```/g, "").trim();
        return {
          respuesta: respuesta || "No he sabido responder a eso. ¿Puedes reformular la pregunta?",
          ...(tabla ? { tabla } : {}),
        };
      }

      consultas++;
      conversacion.push({ role: "assistant", content: "```sql\n" + sql + "\n```" });
      // El SQL que escribió el modelo, en una línea: sin esto no hay forma de saber
      // por qué el chat "no encuentra" algo (filtro equivocado, tabla errónea…).
      const sqlLog = sql.replace(/\s+/g, " ").slice(0, 600);
      try {
        const r = await ejecutarSql(token, sql);
        console.log(`[chat] sql (${r.filas.length} filas): ${sqlLog}`);
        // La tabla que acompaña a la respuesta es la última consulta que trajo
        // un listado (varias filas, o archivos que se puedan abrir).
        if (r.filas.length > 1 || (r.filas.length === 1 && r.columnas.includes("archivo_id"))) {
          tabla = r;
        }
        conversacion.push({ role: "user", content: `[Resultado]\n${resultadoParaModelo(r)}` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[chat] sql con error (${msg}): ${sqlLog}`);
        conversacion.push({
          role: "user",
          content: `[Error de la consulta]\n${msg}\nCorrige la consulta (solo las tablas y columnas del esquema).`,
        });
      }
    }
  } finally {
    await cerrarAcceso(token);
  }
  // Inalcanzable: la última vuelta siempre devuelve.
  return { respuesta: "No he sabido responder a eso. ¿Puedes reformular la pregunta?" };
};

// Tabla en markdown para canales sin tablas propias (n8n → Telegram).
export const tablaAMarkdown = (t: TablaChat, max = 20): string => {
  const visibles = t.columnas
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.endsWith("_id"));
  if (visibles.length === 0) return "";
  const celda = (v: Valor): string => (v === null ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
  const cab = `| ${visibles.map(({ c }) => c.replace(/_/g, " ")).join(" | ")} |`;
  const sep = `| ${visibles.map(() => "---").join(" | ")} |`;
  const filas = t.filas
    .slice(0, max)
    .map((f) => `| ${visibles.map(({ i }) => celda(f[i])).join(" | ")} |`);
  const resto = t.filas.length > max ? `\n\n…y ${t.filas.length - max} más.` : "";
  return [cab, sep, ...filas].join("\n") + resto;
};
