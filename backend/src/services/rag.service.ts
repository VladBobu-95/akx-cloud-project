import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { env } from "../config/env";
import { extraerTexto } from "./extraccion.service";
import { combinarContenido } from "./archivos.service";

const archivoRepo = () => AppDataSource.getRepository(Archivo);

interface OllamaEmbedResponse {
  embeddings?: number[][];
  error?: string;
}

// Solo nomic-embed-text exige prefijos de tarea (search_document/search_query).
// Otros modelos como bge-m3 (multilingüe) no los usan y los empeorarían.
type TipoEmbed = "documento" | "consulta";
const PREFIJO: Record<TipoEmbed, string> = {
  documento: "search_document: ",
  consulta: "search_query: ",
};
const usaPrefijoNomic = (): boolean =>
  env.OLLAMA_EMBED_MODEL.toLowerCase().includes("nomic");

// Genera embeddings (vectores) para una lista de textos con el modelo de Ollama.
export const embeddings = async (
  textos: string[],
  tipo: TipoEmbed,
): Promise<number[][]> => {
  if (textos.length === 0) return [];
  const input = usaPrefijoNomic() ? textos.map((t) => PREFIJO[tipo] + t) : textos;
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // keep_alive mantiene bge-m3 cargado entre búsquedas: sin esto Ollama lo
      // descarga a los 5 min (default) y cada búsqueda en frío paga varios
      // segundos de recarga del modelo. Es pequeño (~1-2 GB), barato de tener fijo.
      body: JSON.stringify({ model: env.OLLAMA_EMBED_MODEL, input, keep_alive: "30m" }),
      // Timeout para no colgarse si Ollama no libera VRAM (ver OLLAMA_TIMEOUT_MS).
      signal: AbortSignal.timeout(env.OLLAMA_TIMEOUT_MS),
    });
  } catch {
    throw new Error("No se puede conectar con Ollama para generar embeddings.");
  }
  const data = (await res.json()) as OllamaEmbedResponse;
  if (!res.ok || data.error || !data.embeddings) {
    throw new Error(`Fallo al generar embeddings: ${data.error ?? res.status}`);
  }
  return data.embeddings;
};

// Trocea el texto en fragmentos de ~TAM caracteres con SOLAPE entre ellos (para
// no cortar ideas en seco). El solape ayuda a que la búsqueda recupere contexto.
const TAM = 1000;
const SOLAPE = 150;

// Similitud mínima (0..1) para considerar un resultado relevante SOLO por
// semántica. Ojo: con bge-m3 sobre documentos parecidos entre sí (p.ej. varias
// facturas del mismo emisor) los scores son casi PLANOS y se solapan con lo ajeno
// —medido: consulta ajena "pedido de material de oficina" ~0.55, consulta buena
// "herramientas de ferretería" ~0.54—, así que NINGÚN umbral separa bien. Por eso
// la vía fiable es la coincidencia por PALABRA (abajo); el umbral solo poda lo
// claramente lejano (recetas/informes médicos quedan ~0.35-0.47). Subirlo mataría
// consultas conceptuales legítimas sin quitar los falsos positivos "comerciales".
const MIN_SCORE = 0.50;

// En el ramo puramente semántico (sin aciertos literales) recortamos la cola:
// tras el mejor resultado, descartamos los que quedan más de GAP por debajo. Evita
// devolver una lista larga de archivos "medio parecidos" cuando la consulta no
// tiene un match claro (bge-m3 asigna ~0.5 a texto español no relacionado, así que
// un umbral absoluto solo no basta: hay que mirar también la distancia al top).
const GAP = 0.10;
export const trocear = (texto: string): string[] => {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (!limpio) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < limpio.length) {
    chunks.push(limpio.slice(i, i + TAM));
    if (i + TAM >= limpio.length) break;
    i += TAM - SOLAPE;
  }
  return chunks;
};

// Literal de pgvector: un array JS [0.1, 0.2] -> "[0.1,0.2]" para insertar como ::vector.
const vecLiteral = (v: number[]): string => `[${v.join(",")}]`;

// Escapa los metacaracteres de regex del texto del usuario para poder incrustarlo
// en un patrón POSIX (`~*`) sin que `.`, `(`, `*`… se interpreten como operadores.
const escaparRegex = (s: string): string => s.replace(/[.*+?()[\]{}|\\^$]/g, "\\$&");

// Conectores que se ignoran al partir la consulta en palabras: no aportan a la
// coincidencia literal y, si se exigieran, "escalera de aluminio" no encontraría
// "Escalera aluminio". (Castellano/catalán/inglés básico.)
const VACIAS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o",
  "u", "e", "al", "en", "con", "para", "por", "a", "les", "dels", "i", "amb",
  "the", "of", "and", "to", "in",
]);

// Parte la consulta en palabras significativas (sin conectores ni tokens de 1
// carácter), en minúsculas y sin duplicados. La coincidencia literal exigirá
// TODAS estas palabras (como palabras completas), en cualquier orden.
const tokenizar = (q: string): string[] => {
  const brutos = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...new Set(brutos.filter((t) => t.length >= 2 && !VACIAS.has(t)))];
};

// Trocea, genera embeddings y guarda los fragmentos para RAG de un texto ya
// resuelto (combinado, en su caso). Devuelve cuántos fragmentos creó. Borra
// los fragmentos previos del archivo (por si se reindexa) antes de insertar.
const reindexarFragmentos = async (
  archivoId: string,
  usuarioId: string,
  texto: string,
  carpetaCompartidaId: string | null = null,
): Promise<number> => {
  await AppDataSource.query(`DELETE FROM "fragmentos" WHERE "archivoId" = $1`, [archivoId]);

  const trozos = trocear(texto);
  if (trozos.length === 0) return 0;

  const vectores = await embeddings(trozos, "documento");
  for (let i = 0; i < trozos.length; i++) {
    // En archivos compartidos guardamos `carpetaCompartidaId` para que la
    // búsqueda semántica los encuentre a cualquier usuario con acceso al rol
    // (no solo al que los subió). En personales va NULL.
    await AppDataSource.query(
      `INSERT INTO "fragmentos" ("archivoId", "propietarioId", "carpetaCompartidaId", "indice", "texto", "embedding")
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [archivoId, usuarioId, carpetaCompartidaId, i, trozos[i], vecLiteral(vectores[i])],
    );
  }
  return trozos.length;
};

// `textoExtraido` y `descripcionManual` se guardan en columnas separadas (ver
// `combinarContenido` en archivos.service.ts) para que el OCR en segundo plano
// y el modal de descripción manual no se pisen entre sí según cuál termine
// antes. Cada vez que se actualiza una de las dos, se relee la otra de BD y se
// reindexa con el contenido combinado de ambas.
const reindexarConCombinado = async (archivoId: string, usuarioId: string): Promise<number> => {
  const archivo = await archivoRepo().findOneBy({ id: archivoId });
  const combinado = combinarContenido(archivo?.textoExtraido, archivo?.descripcionManual);
  return reindexarFragmentos(archivoId, usuarioId, combinado, archivo?.carpetaCompartidaId ?? null);
};

// Actualiza el texto extraído automáticamente (OCR/PDF/DOCX) y reindexa con el
// contenido combinado (+ descripción manual, si ya la había).
export const actualizarTextoExtraido = async (
  archivoId: string,
  texto: string,
  usuarioId: string,
): Promise<number> => {
  await archivoRepo().update(archivoId, { textoExtraido: texto.slice(0, 20000) });
  return reindexarConCombinado(archivoId, usuarioId);
};

// Actualiza la descripción manual del usuario (modal "¿Qué es esta imagen?") y
// reindexa con el contenido combinado (+ texto extraído, si ya lo había).
export const actualizarDescripcionManual = async (
  archivoId: string,
  descripcion: string,
  usuarioId: string,
): Promise<number> => {
  await archivoRepo().update(archivoId, { descripcionManual: descripcion });
  return reindexarConCombinado(archivoId, usuarioId);
};

export const indexarArchivo = async (
  archivo: Archivo,
  buffer: Buffer,
  usuarioId: string,
): Promise<number> => {
  const texto = await extraerTexto(buffer, archivo.mimeType, archivo.nombre);
  if (!texto) return 0;
  return actualizarTextoExtraido(archivo.id, texto, usuarioId);
};

export interface ResultadoSemantico {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string;
  score: number; // 0..1 (mayor = más parecido)
}

interface FilaFragmento {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string;
  dist: string;
  literal: boolean; // true si el fragmento contiene literalmente el texto buscado
}

// Colapsa las filas (varios fragmentos por archivo) a un resultado por archivo,
// quedándose con el fragmento más parecido (las filas vienen ordenadas por dist).
const dedupPorArchivo = (filas: FilaFragmento[], k: number): ResultadoSemantico[] => {
  const vistos = new Set<string>();
  const resultados: ResultadoSemantico[] = [];
  for (const f of filas) {
    if (vistos.has(f.archivoId)) continue;
    vistos.add(f.archivoId);
    resultados.push({
      archivoId: f.archivoId,
      nombre: f.nombre,
      carpeta: f.carpeta,
      fragmento: f.fragmento,
      score: Math.max(0, 1 - Number(f.dist)),
    });
    if (resultados.length >= k) break;
  }
  return resultados;
};

// Búsqueda HÍBRIDA: un fragmento entra si (a) es semánticamente parecido
// (distancia coseno por debajo del umbral) O (b) contiene TODAS las palabras
// significativas de la consulta como PALABRAS COMPLETAS (en cualquier orden). Así
// "escalera de aluminio" encuentra "Escalera aluminio" y "pintura" suelta sale sin
// devolver basura.
//
// El match literal usa el operador regex `~*` con límites de palabra POSIX (`\y`),
// NO un ILIKE `%texto%` por subcadena: buscar "iva" NO debe acertar dentro de
// "privado"/"activo" y arrastrar archivos ajenos (un acierto literal SUPRIME el
// ranking semántico, así que una subcadena espuria envenenaba todos los
// resultados). Exigir TODAS las palabras (AND) evita el otro extremo: no basta con
// compartir una palabra común. unaccent() en ambos lados (igual que la analítica de
// facturas) para que "tecnologia" encuentre "Tecnología" — requiere la extensión
// unaccent (migración HabilitarUnaccent). `filtroAcceso` acota el ámbito (solo
// personal, o una carpeta compartida concreta) y aporta sus parámetros extra.
const buscarConFiltro = async (
  consulta: string,
  k: number,
  filtroAcceso: string,
  paramsAcceso: unknown[],
): Promise<ResultadoSemantico[]> => {
  const texto = (consulta ?? "").trim();
  if (!texto) return [];

  const [vec] = await embeddings([texto], "consulta");
  if (!vec) return [];

  const maxDist = 1 - MIN_SCORE;
  // Layout de parámetros: $1=vector, $2=maxDist, $3=limit, luego los de acceso, y
  // al final uno por cada palabra de la consulta (patrón `\ypalabra\y`, límite de
  // palabra POSIX → coincidencia por palabra completa, no subcadena).
  const tokens = tokenizar(texto);
  const baseTok = 4 + paramsAcceso.length; // índice $ del primer token
  const tokenPatrones = tokens.map((t) => `\\y${escaparRegex(t)}\\y`);
  // Condición literal = TODAS las palabras presentes (AND). Sin palabras
  // significativas (consulta de solo conectores/símbolos) no hay literal posible.
  const condLiteral =
    tokens.length > 0
      ? tokens
          .map((_, i) => `unaccent(f."texto") ~* unaccent($${baseTok + i})`)
          .join(" AND ")
      : "false";
  // Se prioriza la coincidencia LITERAL (`literal DESC`): un fragmento que contiene
  // todas las palabras es un acierto seguro y va SIEMPRE primero, aunque su
  // similitud semántica sea mediocre. Sin esto, los aciertos literales con `dist`
  // alta caían al fondo del ORDER BY y el `LIMIT` los cortaba antes del dedup,
  // dejando arriba falsos positivos semánticos. Dentro de cada grupo se ordena por
  // distancia.
  const filas: FilaFragmento[] = await AppDataSource.query(
    `SELECT a."id" AS "archivoId", a."nombre" AS "nombre", a."carpeta" AS "carpeta",
            f."texto" AS "fragmento", (f."embedding" <=> $1::vector) AS "dist",
            (${condLiteral}) AS "literal"
     FROM "fragmentos" f
     JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${filtroAcceso}
       AND a."eliminadoEn" IS NULL
       AND ( (f."embedding" <=> $1::vector) <= $2 OR (${condLiteral}) )
     ORDER BY "literal" DESC, "dist" ASC
     LIMIT $3`,
    [vecLiteral(vec), maxDist, k * 4, ...paramsAcceso, ...tokenPatrones],
  );
  // Si algún fragmento contiene la palabra buscada, devolvemos SOLO esos: una
  // búsqueda por palabra concreta ("devolución") no debe mezclar facturas
  // parecidas que no la contienen. El relleno semántico solo entra cuando NADIE
  // la contiene literalmente (consultas conceptuales tipo "facturas de transporte",
  // cuya frase completa casi nunca aparece tal cual → caen a semántico como antes).
  const hayLiteral = filas.some((f) => f.literal);
  const relevantes = hayLiteral ? filas.filter((f) => f.literal) : filas;
  const resultados = dedupPorArchivo(relevantes, k);
  // Ramo puramente semántico: recorta la cola de resultados flojos respecto al
  // mejor (ver GAP). No se aplica a los aciertos literales (son exactos).
  if (!hayLiteral && resultados.length > 1) {
    const mejor = resultados[0].score;
    return resultados.filter((r) => r.score >= mejor - GAP);
  }
  return resultados;
};

// Búsqueda semántica PERSONAL: solo el contenido propio del usuario (fragmentos
// sin carpeta compartida). Lo compartido tiene su propio buscador acotado.
export const buscarSemantica = async (
  usuarioId: string,
  consulta: string,
  k = 5,
): Promise<ResultadoSemantico[]> =>
  buscarConFiltro(
    consulta,
    k,
    `(f."propietarioId" = $4 AND f."carpetaCompartidaId" IS NULL)`,
    [usuarioId],
  );

// Búsqueda semántica dentro de UNA carpeta compartida (mismo buscador que "Mis
// archivos" pero acotado a ese espacio). El control de acceso lo hace el llamador
// (compartido.service.verificarAcceso) antes de invocar esto.
export const buscarEnCarpetaCompartida = async (
  carpetaCompartidaId: string,
  consulta: string,
  k = 5,
): Promise<ResultadoSemantico[]> =>
  buscarConFiltro(consulta, k, `f."carpetaCompartidaId" = $4`, [carpetaCompartidaId]);
