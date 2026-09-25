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

// ¿El modelo tiene modo "pensamiento" (qwen3, deepseek-r1…)? Se consulta una vez
// a /api/show y se cachea. Hace falta porque a esos modelos hay que decirles
// `think` explícitamente (si no, piensan por defecto y tardan mucho), y a los que
// no lo tienen no se les puede mandar `think: true` (Ollama responde error).
const cacheThink = new Map<string, boolean>();
export const soportaThink = async (modelo: string): Promise<boolean> => {
  const cacheado = cacheThink.get(modelo);
  if (cacheado !== undefined) return cacheado;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({ model: modelo }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { capabilities?: string[] };
    const soporta = res.ok && (data.capabilities ?? []).includes("thinking");
    cacheThink.set(modelo, soporta);
    return soporta;
  } catch {
    return false; // sin cachear: se reintenta en la siguiente llamada
  }
};

// Campo `think` para el body de /api/chat: solo se manda si el modelo lo admite.
export const campoThink = async (
  modelo: string,
  pensar: boolean,
): Promise<{ think?: boolean }> => ((await soportaThink(modelo)) ? { think: pensar } : {});

// Compara contra el nombre exacto y también sin el sufijo ":tag" (ollama list
// puede devolver "deepseek-ocr:latest" cuando en .env solo se puso "deepseek-ocr").
const coincide = (instalado: string, esperado: string): boolean =>
  instalado === esperado || instalado.split(":")[0] === esperado.split(":")[0];

// Se llama al arrancar la API: avisa en los logs (sin bloquear el arranque) si
// algún modelo configurado en .env no está descargado en Ollama. Sin esto, un
// modelo que falta falla en silencio (sin texto para esa imagen/factura, error
// solo logueado para el chat) y nadie se entera hasta ver resultados de mala calidad.
export const verificarModelosOllama = async (): Promise<void> => {
  let data: OllamaTagsResponse;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { headers: ollamaHeaders() });
    data = (await res.json()) as OllamaTagsResponse;
  } catch (err) {
    console.warn(`⚠️  No se pudo conectar con Ollama (${env.OLLAMA_URL}) para verificar los modelos:`, err);
    return;
  }
  const instalados = data.models?.map((m) => m.name) ?? [];
  // OLLAMA_CAPTION_MODEL (1ª pasada de visión) NO se verifica: es opcional y tiene
  // fallback en cascada (deepseek-ocr → Tesseract), así que si falta el sistema
  // degrada sin romper. Avisar por él solo generaba ruido en máquinas que no lo usan.
  const requeridos = {
    OLLAMA_MODEL: env.OLLAMA_MODEL,
    OLLAMA_OCR_MODEL: env.OLLAMA_OCR_MODEL,
  };
  for (const [variable, modelo] of Object.entries(requeridos)) {
    const ok = instalados.some((i) => coincide(i, modelo));
    if (!ok) {
      console.warn(
        `⚠️  ${variable}="${modelo}" no está descargado en Ollama (${env.OLLAMA_URL}). ` +
          `Las funciones que lo usan fallarán o caerán a un fallback de peor calidad. ` +
          `Descárgalo con: docker exec clouddrive-ollama ollama pull ${modelo}`,
      );
    }
  }
};
