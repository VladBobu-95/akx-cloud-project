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
  // Superadmin de la plataforma (multi-tenant). Al arrancar, si no existe ningún
  // usuario con rol "superadmin" y AMBAS variables están definidas, se siembra uno
  // (sin empresa). Es la única cuenta que se crea sin pasar por otra (no hay
  // auto-registro público). En despliegues ya sembrados pueden quedar vacías.
  // Tratamos "" como ausente: en Docker una variable no definida en .env llega
  // como cadena vacía, que si no fallaría la validación de email/longitud.
  SUPERADMIN_EMAIL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().email().optional(),
  ),
  SUPERADMIN_PASSWORD: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(8).optional(),
  ),
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
  // Timeout (ms) de CADA llamada a Ollama (embeddings/visión/extracción). Sin
  // esto, si Ollama se cuelga esperando VRAM —p. ej. no puede cargar el modelo
  // que toca porque otro sigue fijado en la GPU por su keep_alive— el `fetch` se
  // queda colgado indefinidamente y la tarea del worker se eterniza en
  // "escaneando" (el archivo nunca sale de "procesando"). Con el timeout, la
  // llamada falla y la tarea reintenta/marca error en vez de colgarse. 180 s
  // cubre de sobra una inferencia lenta real (incl. cargar deepseek-ocr de disco
  // y OCR en CPU), pero corta muy por debajo del keep_alive de 10 min.
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  // Worker de la cola durable (tareas.service.ts):
  //  - WORKER_CONCURRENCIA: cuántas tareas se procesan a la vez. 1 por defecto,
  //    como las colas en memoria anteriores: el trabajo pesado va a Ollama/GPU y
  //    paralelizarlo la satura (más lento en total, riesgo de quedarse sin VRAM).
  //  - WORKER_POLL_MS: cada cuánto sondea la tabla cuando no hay nada que hacer.
  //  - WORKER_MAX_INTENTOS: reintentos antes de marcar la tarea como "error".
  WORKER_CONCURRENCIA: z.coerce.number().int().min(1).default(1),
  // Sondeo de respaldo: con despertar inmediato al encolar, este intervalo solo
  // cubre reintentos (backoff) y trabajo de otra instancia, así que puede ser
  // amplio sin penalizar la latencia normal (y mantiene los logs de dev limpios).
  WORKER_POLL_MS: z.coerce.number().int().min(200).default(3000),
  WORKER_MAX_INTENTOS: z.coerce.number().int().min(1).default(3),
  //  - WORKER_TAREA_TIMEOUT_MS: tope DURO por tarea. Red de seguridad: aunque cada
  //    operación pesada (rasterizado, Tesseract, Ollama) ya tiene su propio
  //    timeout, si alguna se colgara sin cortar (el archivo se queda "procesando"
  //    para siempre, tarea "en_proceso" eterna), este límite aborta la tarea, la
  //    marca como fallo y deja que reintente/termine. 10 min cubre de sobra el peor
  //    caso real (OCR de un PDF escaneado de varias páginas) sin dejar nada pegado.
  WORKER_TAREA_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(600_000),
  // Tope de tareas pendientes/en proceso por usuario (#8): evita que uno solo
  // encole miles de archivos y monopolice el worker. Alto para no estorbar
  // subidas masivas normales.
  MAX_BACKLOG_USUARIO: z.coerce.number().int().min(1).default(200),
  // Mantenimiento periódico (reconciliacion.service.ts, #5):
  //  - MANTENIMIENTO_INTERVAL_HORAS: cada cuánto reconciliar MinIO↔Postgres y
  //    aplicar la retención de papelera.
  //  - RETENCION_PAPELERA_DIAS: purga definitiva de lo que lleve más de N días
  //    en la papelera. 0 = desactivado (la papelera no se vacía sola), opt-in.
  MANTENIMIENTO_INTERVAL_HORAS: z.coerce.number().min(1).default(24),
  RETENCION_PAPELERA_DIAS: z.coerce.number().int().min(0).default(0),
  // Retención del registro de actividad de carpetas compartidas
  // (eventos_compartido): se purga lo que lleve más de N días. 0 = sin límite
  // (no se purga nunca). Por defecto 1 año.
  RETENCION_LOGS_DIAS: z.coerce.number().int().min(0).default(365),
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
