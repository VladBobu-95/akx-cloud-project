import dotenv from "dotenv";
import { z } from "zod";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const envSchema = z.object({
  // "development" en local, "production" en el servidor, "test" para los tests
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(5433),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USER: z.string(),
  MINIO_PASSWORD: z.string(),
  MINIO_BUCKET: z.string().default("archivos"),
  JWT_SECRET: z.string().min(16),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:3b"),
  // Modelo de embeddings para la búsqueda semántica (RAG). nomic-embed-text = 768 dims.
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  // Modelo de visión para OCR de imágenes de factura (mejor que Tesseract).
  // Si falla, se usa Tesseract como fallback.
  OLLAMA_OCR_MODEL: z.string().default("deepseek-ocr"),
  // Modelo de visión general para describir fotos sin texto (deepseek-ocr es
  // solo-OCR y no sabe hacerlo: alucina en vez de describir).
  OLLAMA_CAPTION_MODEL: z.string().default("llava"),
});

// Si falta alguna variable obligatoria, el servidor no arranca y muestra exactamente
// que variable falta. Asi nunca arranca con configuracion incompleta.
const resultado = envSchema.safeParse(process.env);

if (!resultado.success) {
  console.error("Variables de entorno invalidas o faltantes:");
  resultado.error.issues.forEach((issue) => {
    console.error(`  -> ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1); // Mata el proceso: el servidor no arranca
}

export const env = resultado.data;
