import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { env } from "../config/env";
import { extraerTexto } from "./extraccion.service";

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
      body: JSON.stringify({ model: env.OLLAMA_EMBED_MODEL, input }),
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

// Similitud mínima (0..1) para considerar un resultado relevante. Por debajo de
// esto se descarta: evita devolver documentos que no tienen que ver con la consulta.
// Calibrado para bge-m3: lo relevante en español queda ~0.45+ y lo ajeno por debajo.
const MIN_SCORE = 0.50;
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

// Indexa un archivo: extrae su texto, lo trocea, genera embeddings y guarda los
// fragmentos. Devuelve cuántos fragmentos creó. Pensado para llamarse en segundo
// plano tras la subida (los embeddings en CPU pueden tardar).
// Indexa un texto ya disponible (extraído o escrito a mano por el usuario):
// lo guarda en archivo.textoExtraido y regenera sus fragmentos para RAG.
export const indexarTexto = async (
  archivoId: string,
  texto: string,
  usuarioId: string,
): Promise<number> => {
  await archivoRepo().update(archivoId, { textoExtraido: texto.slice(0, 20000) });

  // Borra fragmentos previos de este archivo (por si se reindexa) antes de insertar.
  await AppDataSource.query(`DELETE FROM "fragmentos" WHERE "archivoId" = $1`, [archivoId]);

  const trozos = trocear(texto);
  if (trozos.length === 0) return 0;

  const vectores = await embeddings(trozos, "documento");
  for (let i = 0; i < trozos.length; i++) {
    await AppDataSource.query(
      `INSERT INTO "fragmentos" ("archivoId", "propietarioId", "indice", "texto", "embedding")
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [archivoId, usuarioId, i, trozos[i], vecLiteral(vectores[i])],
    );
  }
  return trozos.length;
};

export const indexarArchivo = async (
  archivo: Archivo,
  buffer: Buffer,
  usuarioId: string,
): Promise<number> => {
  const texto = await extraerTexto(buffer, archivo.mimeType, archivo.nombre);
  if (!texto) return 0;
  return indexarTexto(archivo.id, texto, usuarioId);
};

export interface ResultadoSemantico {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string;
  score: number; // 0..1 (mayor = más parecido)
}

// Búsqueda semántica: convierte la consulta en embedding y devuelve los archivos
// cuyo contenido más se parece (un fragmento representativo por archivo).
export const buscarSemantica = async (
  usuarioId: string,
  consulta: string,
  k = 5,
): Promise<ResultadoSemantico[]> => {
  const texto = (consulta ?? "").trim();
  if (!texto) return [];

  const [vec] = await embeddings([texto], "consulta");
  if (!vec) return [];

  // Búsqueda HÍBRIDA: un fragmento entra si (a) es semánticamente parecido
  // (distancia coseno por debajo del umbral) O (b) contiene literalmente el texto
  // buscado (ILIKE). Así una palabra suelta como "pintura" que aparece en la
  // factura sale aunque su similitud semántica sea media, sin devolver basura.
  const maxDist = 1 - MIN_SCORE;
  const kw = `%${texto}%`;
  const filas: Array<{
    archivoId: string;
    nombre: string;
    carpeta: string;
    fragmento: string;
    dist: string;
  }> = await AppDataSource.query(
    `SELECT a."id" AS "archivoId", a."nombre" AS "nombre", a."carpeta" AS "carpeta",
            f."texto" AS "fragmento", (f."embedding" <=> $2::vector) AS "dist"
     FROM "fragmentos" f
     JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE f."propietarioId" = $1 AND a."eliminadoEn" IS NULL
       AND ( (f."embedding" <=> $2::vector) <= $3 OR f."texto" ILIKE $4 )
     ORDER BY "dist" ASC
     LIMIT $5`,
    [usuarioId, vecLiteral(vec), maxDist, kw, k * 4],
  );

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
