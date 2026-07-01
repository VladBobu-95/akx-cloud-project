import { env } from "../config/env";

interface OllamaTagsResponse {
  models?: { name: string }[];
}

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
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`);
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
    OLLAMA_EMBED_MODEL: env.OLLAMA_EMBED_MODEL,
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
