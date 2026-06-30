import { AppDataSource } from "../config/database";
import { Tarea } from "../entities/Tarea";
import { Archivo } from "../entities/Archivo";
import { minioClient } from "../config/minio";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { indexarArchivo } from "./rag.service";
import {
  escanearFactura,
  marcarEnProceso,
  limpiarEstadoSiNoEsFactura,
  esArchivoFactura,
} from "./facturas.service";

// ---------------------------------------------------------------------------
// Cola de trabajos DURABLE en Postgres. Sustituye a las colas en memoria
// (colaOcr/colaExtraccion) que se perdían al reiniciar la API. Ver Tarea.ts.
// ---------------------------------------------------------------------------

// Prioridades (menor = antes). Reproducen el agrupado por fases del diseño
// anterior para que Ollama no descargue/cargue modelos por archivo: primero el
// texto barato y el escaneo de PDFs, luego el OCR de imágenes (deepseek), y al
// final el escaneo de factura derivado de esas imágenes (qwen).
export const P_TEXTO = 0; // indexar de PDF/DOCX/TXT (sin IA de visión)
export const P_ALTA = 0; // autoescanear de PDF / escaneo manual (rápido, prioritario)
export const P_OCR = 1; // indexar de imagen (OCR con deepseek-vision)
export const P_IMG_SCAN = 2; // autoescanear derivado de una imagen ya OCR'eada

const repo = () => AppDataSource.getRepository(Tarea);
const archivoRepo = () => AppDataSource.getRepository(Archivo);

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Despertar inmediato: en vez de depender solo del sondeo (que inundaría los
// logs si fuera muy frecuente), al encolar una tarea avisamos a los bucles que
// estén esperando para que la recojan al instante. El sondeo periódico queda
// como respaldo para reintentos con backoff y, a futuro, trabajo de otra
// instancia. `enEspera` guarda los "resolvers" de los bucles dormidos.
const enEspera = new Set<() => void>();
const dormirHastaTrabajo = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    let hecho = false;
    const fin = (): void => {
      if (hecho) return;
      hecho = true;
      enEspera.delete(fin);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(fin, ms);
    enEspera.add(fin);
  });
const despertarWorker = (): void => {
  for (const fin of [...enEspera]) fin();
};

export interface NuevaTarea {
  tipo: "indexar" | "autoescanear";
  archivoId: string;
  usuarioId: string;
  prioridad?: number;
  pista?: string;
}

// Encola una tarea (inserta una fila). El worker la recogerá. Idempotencia y
// supervivencia a reinicios vienen de que el cuerpo de la tarea relee los bytes
// desde MinIO, no de un buffer en memoria.
export const encolarTarea = async (t: NuevaTarea): Promise<void> => {
  await repo().insert({
    tipo: t.tipo,
    archivoId: t.archivoId,
    usuarioId: t.usuarioId,
    prioridad: t.prioridad ?? 0,
    maxIntentos: env.WORKER_MAX_INTENTOS,
    pista: t.pista ?? null,
  });
  despertarWorker(); // pickup inmediato sin esperar al sondeo
};

// Marca el indexado como "pendiente" al subir, para feedback inmediato en el
// explorador antes de que el worker recoja la tarea.
export const marcarIndexadoPendiente = async (archivoId: string): Promise<void> => {
  await archivoRepo().update(archivoId, { estadoIndexado: "pendiente" });
};

// Cuenta el trabajo pendiente/en curso de un usuario (lo usa el límite de
// concurrencia por usuario, Fase #8).
export const tareasActivasDeUsuario = async (usuarioId: string): Promise<number> =>
  repo()
    .createQueryBuilder("t")
    .where(`t."usuarioId" = :usuarioId`, { usuarioId })
    .andWhere(`t."estado" IN ('pendiente', 'en_proceso')`)
    .getCount();

// Descarga el binario de MinIO a un Buffer (el worker no recibe el buffer en
// memoria: lo relee del objeto ya persistido).
const descargarBuffer = async (clave: string): Promise<Buffer> => {
  const stream = await minioClient.getObject(env.MINIO_BUCKET, clave);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

// --- Cuerpos de las tareas ---

const ejecutarIndexar = async (t: Tarea): Promise<void> => {
  const archivo = await archivoRepo().findOne({ where: { id: t.archivoId } });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");

  await archivoRepo().update(archivo.id, { estadoIndexado: "indexando" });
  await marcarEnProceso(archivo); // estadoEscaneo = "escaneando" (spinner del explorador)

  const buffer = await descargarBuffer(archivo.claveMinio);
  await indexarArchivo(archivo, buffer, t.usuarioId);

  await archivoRepo().update(archivo.id, {
    estadoIndexado: "indexado",
    indexadoEn: new Date(),
  });

  // Tras indexar, si es candidato a factura encadenamos el escaneo (fase 2);
  // si no, limpiamos el estado para que el spinner no se quede encendido.
  // Los archivos en carpetas COMPARTIDAS no se auto-escanean: una factura
  // compartida no debe atribuirse al usuario que la subió (la analítica de
  // facturas es personal). El texto/indexado RAG sí se hace para la búsqueda.
  if (!archivo.carpetaCompartidaId && esArchivoFactura(archivo)) {
    await encolarTarea({
      tipo: "autoescanear",
      archivoId: archivo.id,
      usuarioId: t.usuarioId,
      prioridad: /^image\//.test(archivo.mimeType) ? P_IMG_SCAN : P_ALTA,
    });
  } else {
    await limpiarEstadoSiNoEsFactura(archivo);
  }
};

const ejecutarAutoescanear = async (t: Tarea): Promise<void> => {
  // soloSiFactura: si no parece factura no guarda nada y no lanza (deja el
  // archivo en "no_factura"); el texto ya se extrajo en la tarea de indexado.
  await escanearFactura(t.usuarioId, t.archivoId, {
    soloSiFactura: true,
    pista: t.pista ?? undefined,
  });
};

// --- Worker ---

// Reclama la siguiente tarea disponible de forma atómica. FOR UPDATE SKIP
// LOCKED permite que varios bucles (o, a futuro, varias instancias de API) no
// se pisen: cada uno coge una fila distinta sin bloquearse entre sí.
const reclamarSiguiente = async (): Promise<Tarea | null> => {
  const qr = AppDataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    const filas = (await qr.query(
      `SELECT * FROM "tareas"
         WHERE "estado" = 'pendiente' AND "disponibleEn" <= now()
         ORDER BY "prioridad" ASC, "creadoEn" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
    )) as Tarea[];
    if (filas.length === 0) {
      await qr.commitTransaction();
      return null;
    }
    const fila = filas[0];
    await qr.query(
      `UPDATE "tareas" SET "estado" = 'en_proceso', "actualizadoEn" = now() WHERE "id" = $1`,
      [fila.id],
    );
    await qr.commitTransaction();
    return fila;
  } catch (e) {
    await qr.rollbackTransaction();
    throw e;
  } finally {
    await qr.release();
  }
};

// Gestiona un fallo: reintenta con backoff si es transitorio, o marca "error"
// (y refleja el estado en el archivo) si se agotaron los intentos o el error es
// definitivo (4xx: archivo borrado, sin permiso...).
const manejarFallo = async (t: Tarea, err: unknown): Promise<void> => {
  const mensaje = err instanceof Error ? err.message : String(err);
  const definitivo = err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500;
  const nuevosIntentos = t.intentos + 1;
  const agotado = nuevosIntentos >= t.maxIntentos;

  if (!definitivo && !agotado) {
    // Backoff exponencial con techo (5s, 10s, 20s... máx 60s).
    const backoff = Math.min(60_000, 5_000 * 2 ** nuevosIntentos);
    await repo().update(t.id, {
      estado: "pendiente",
      intentos: nuevosIntentos,
      error: mensaje,
      disponibleEn: new Date(Date.now() + backoff),
    });
    console.warn(
      `[worker] tarea ${t.tipo} ${t.id} falló (intento ${nuevosIntentos}/${t.maxIntentos}), reintento en ${backoff}ms: ${mensaje}`,
    );
    return;
  }

  // Definitivo o sin reintentos: marcar error y reflejarlo en el archivo.
  await repo().update(t.id, { estado: "error", intentos: nuevosIntentos, error: mensaje });
  if (t.tipo === "indexar") {
    await archivoRepo().update(t.archivoId, { estadoIndexado: "error", estadoEscaneo: null });
  } else {
    // El estado fino (no_factura) ya lo deja escanearFactura; aquí solo cubrimos
    // el caso de fallo técnico tras agotar reintentos.
    await archivoRepo().update(t.archivoId, { estadoEscaneo: "error" });
  }
  console.error(`[worker] tarea ${t.tipo} ${t.id} agotada/definitiva: ${mensaje}`);
};

const procesarTarea = async (t: Tarea): Promise<void> => {
  try {
    if (t.tipo === "indexar") await ejecutarIndexar(t);
    else await ejecutarAutoescanear(t);
    await repo().update(t.id, { estado: "ok", error: null });
  } catch (err) {
    await manejarFallo(t, err);
  }
};

let pararSolicitado = false;
let buclesActivos = 0;

const bucle = async (): Promise<void> => {
  buclesActivos++;
  try {
    while (!pararSolicitado) {
      let t: Tarea | null = null;
      try {
        t = await reclamarSiguiente();
      } catch (e) {
        console.error("[worker] error reclamando tarea:", e);
        await dormir(env.WORKER_POLL_MS);
        continue;
      }
      if (!t) {
        await dormirHastaTrabajo(env.WORKER_POLL_MS);
        continue;
      }
      await procesarTarea(t);
    }
  } finally {
    buclesActivos--;
  }
};

// Arranca el worker: reencola tareas "en_proceso" colgadas de un crash anterior
// y lanza WORKER_CONCURRENCIA bucles de proceso. Llamar tras initialize() de la
// BD. No se arranca en tests (no hay Ollama).
export const iniciarWorker = async (): Promise<void> => {
  pararSolicitado = false;
  // Tareas que quedaron "en_proceso" cuando murió el proceso → reanudarlas.
  await repo().update({ estado: "en_proceso" }, { estado: "pendiente" });
  const n = env.WORKER_CONCURRENCIA;
  for (let i = 0; i < n; i++) void bucle();
  console.log(`[worker] iniciado (${n} bucle/s, poll ${env.WORKER_POLL_MS}ms)`);
};

// Para el worker de forma ordenada (tests / apagado).
export const detenerWorker = async (): Promise<void> => {
  pararSolicitado = true;
  while (buclesActivos > 0) await dormir(50);
};
