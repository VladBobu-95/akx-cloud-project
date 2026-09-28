import { env } from "./env";

interface OllamaTagsResponse {
  models?: { name: string }[];
}

// Headers comunes a todas las llamadas a Ollama. Si hay OLLAMA_API_KEY, se
// manda Bearer (proxy/apikey delante de Ollama). Si no, queda como antes.
export const ollamaHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.OLLAMA_API_KEY) {
    headers.Authorization = `Bearer ${env.OLLAMA_API_KEY}`;
  }
  return headers;
};

// keep_alive de TODAS las llamadas (chat, facturas, OCR). Es el mismo modelo para
// todo y Ollama se queda con el keep_alive de la última llamada: con valores
// distintos, un escaneo acortaba el del chat y la siguiente pregunta cargaba el
// modelo en frío.
export const KEEP_ALIVE = "30m";

// Capacidades del modelo según /api/show ("completion", "vision", "thinking"…).
// Se consulta una vez y se cachea. null = /api/show no respondió (p. ej. un proxy
// delante de Ollama que solo deja pasar algunas rutas).
const cacheCapacidades = new Map<string, string[] | null>();
const capacidadesModelo = async (modelo: string): Promise<string[] | null> => {
  if (cacheCapacidades.has(modelo)) return cacheCapacidades.get(modelo)!;
  let capacidades: string[] | null = null;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({ model: modelo }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { capabilities?: string[] };
    if (res.ok && Array.isArray(data.capabilities)) capacidades = data.capabilities;
  } catch {
    // Sin respuesta de /api/show: quien llama decide el respaldo.
  }
  cacheCapacidades.set(modelo, capacidades);
  return capacidades;
};

// ¿El modelo tiene modo "pensamiento" (qwen3, deepseek-r1…)? Hace falta porque a
// esos modelos hay que decirles `think` explícitamente (si no, piensan por defecto
// y tardan mucho), y a los que no lo tienen no se les puede mandar `think: true`
// (Ollama responde error).
// Respaldo por nombre si /api/show no responde: familias conocidas con modo pensamiento.
const THINK_POR_NOMBRE = /^(qwen3|deepseek-r1|gpt-oss|magistral|phi4-reasoning|cogito)/i;
export const soportaThink = async (modelo: string): Promise<boolean> => {
  const capacidades = await capacidadesModelo(modelo);
  return capacidades ? capacidades.includes("thinking") : THINK_POR_NOMBRE.test(modelo);
};

// Campo `think` para el body de /api/chat: solo se manda si el modelo lo admite.
export const campoThink = async (
  modelo: string,
  pensar: boolean,
): Promise<{ think?: boolean }> => ((await soportaThink(modelo)) ? { think: pensar } : {});

// Compara contra el nombre exacto y también sin el sufijo ":tag" (ollama list
// puede devolver "qwen3.5:latest" cuando en .env solo se puso "qwen3.5").
const coincide = (instalado: string, esperado: string): boolean =>
  instalado === esperado || instalado.split(":")[0] === esperado.split(":")[0];

// Se llama al arrancar la API: avisa en los logs (sin bloquear el arranque) si el
// modelo de .env no está descargado en Ollama o no tiene visión. Sin esto, falla
// en silencio (chat caído, imágenes sin texto o solo con el de Tesseract) y nadie
// se entera hasta ver resultados de mala calidad.
export const verificarModelosOllama = async (): Promise<void> => {
  const modelo = env.OLLAMA_MODEL;
  let data: OllamaTagsResponse;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { headers: ollamaHeaders() });
    data = (await res.json()) as OllamaTagsResponse;
  } catch (err) {
    console.warn(`⚠️  No se pudo conectar con Ollama (${env.OLLAMA_URL}) para verificar el modelo:`, err);
    return;
  }
  const instalados = data.models?.map((m) => m.name) ?? [];
  if (!instalados.some((i) => coincide(i, modelo))) {
    console.warn(
      `⚠️  OLLAMA_MODEL="${modelo}" no está descargado en Ollama (${env.OLLAMA_URL}). ` +
        `El chat, las facturas y el OCR de imágenes fallarán. ` +
        `Descárgalo con: docker exec clouddrive-ollama ollama pull ${modelo}`,
    );
    return;
  }
  const capacidades = await capacidadesModelo(modelo);
  if (capacidades && !capacidades.includes("vision")) {
    console.warn(
      `⚠️  OLLAMA_MODEL="${modelo}" no tiene visión: las imágenes solo se leerán con ` +
        `Tesseract (sin descripción de fotos). Usa un modelo multimodal.`,
    );
  }
};
