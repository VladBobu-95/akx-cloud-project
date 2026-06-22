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
  // Orígenes permitidos por CORS. "*" = cualquiera (cómodo en dev; aceptable con
  // auth por Bearer token, sin cookies). En producción conviene fijar el dominio
  // del front (uno o varios separados por coma) para reducir superficie.
  CORS_ORIGIN: z.string().default("*"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  // Modelo del chat (function calling). Por defecto el de la familia documentada
  // para el servidor; en máquinas pequeñas se sobreescribe por .env.
  OLLAMA_MODEL: z.string().default("qwen2.5-coder:14b"),
  // Modelo de embeddings para la búsqueda semántica (RAG). bge-m3 = 1024 dims,
  // que es lo que espera la columna "embedding" vector(1024) (migración 1761).
  // OJO: cambiar a un modelo con otra dimensión rompe el INSERT de fragmentos.
  OLLAMA_EMBED_MODEL: z.string().default("bge-m3"),
  // Cascada de visión para imágenes (ver `ocrImagen` en extraccion.service.ts):
  //  - OLLAMA_CAPTION_MODEL: 1ª pasada, modelo ligero (granite3.2-vision). Rápido,
  //    cabe en GPU y hace las dos cosas — transcribe texto si lo hay o describe la
  //    foto si no — sin el bucle degenerado de un modelo solo-OCR.
  //  - OLLAMA_OCR_MODEL: 2ª pasada, OCR especialista (deepseek-ocr). Solo se usa
  //    si la 1ª pasada detecta que parece una factura con importes, para no
  //    equivocar dígitos. Más lento, por eso no se lanza en todo.
  // Poniendo ambos al mismo modelo, la 2ª pasada se desactiva (máquinas con un
  // solo VLM).
  OLLAMA_OCR_MODEL: z.string().default("deepseek-ocr"),
  OLLAMA_CAPTION_MODEL: z.string().default("granite3.2-vision"),
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
