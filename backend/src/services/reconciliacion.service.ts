import { LessThan } from "typeorm";
import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { minioClient } from "../config/minio";
import { env } from "../config/env";
import { borrarPermanente } from "./archivos.service";

// Mantenimiento periódico (#5): mantiene la coherencia entre MinIO y Postgres y
// aplica la retención de papelera. La subida hace MinIO→Postgres con borrado
// compensatorio, y borrarPermanente hace MinIO→Postgres, pero ninguno es
// atómico: un crash entre los dos pasos puede dejar un binario huérfano (objeto
// en MinIO sin fila) o una fila apuntando a un objeto inexistente.

const archivoRepo = () => AppDataSource.getRepository(Archivo);

// Margen de antigüedad: NO tocamos objetos recién creados, porque la subida
// escribe en MinIO ANTES de insertar la fila — un objeto de hace segundos puede
// ser una subida con su INSERT todavía en vuelo, no un huérfano.
const MARGEN_HUERFANO_MS = 60 * 60 * 1000; // 1 hora

interface ObjetoMinio {
  name: string;
  lastModified: Date;
}

const listarObjetosMinio = (): Promise<ObjetoMinio[]> =>
  new Promise((resolve, reject) => {
    const objetos: ObjetoMinio[] = [];
    const stream = minioClient.listObjectsV2(env.MINIO_BUCKET, "", true);
    stream.on("data", (o) => {
      if (o.name) objetos.push({ name: o.name, lastModified: o.lastModified ?? new Date(0) });
    });
    stream.on("end", () => resolve(objetos));
    stream.on("error", reject);
  });

// Reconciliación: detecta objetos MinIO sin fila (huérfanos) y filas con objeto
// inexistente (colgadas). Limpia los huérfanos CLAROS (sin fila y más viejos que
// el margen); las filas colgadas solo se loguean (borrar la fila perdería la
// metadata; conviene revisarlas a mano). Conservador a propósito.
export const reconciliarMinioPostgres = async (
  margenMs: number = MARGEN_HUERFANO_MS,
): Promise<{
  huerfanosBorrados: number;
  filasColgadas: number;
}> => {
  const objetos = await listarObjetosMinio();
  // Claves de TODOS los archivos (incl. los de la papelera: siguen teniendo
  // objeto en MinIO). Si esta query fallara, lanzaría y abortaría sin borrar nada.
  const filas = await archivoRepo().find({ select: { claveMinio: true }, withDeleted: true });
  const clavesEnBd = new Set(filas.map((f) => f.claveMinio));
  const nombresEnMinio = new Set(objetos.map((o) => o.name));

  const ahora = Date.now();
  let huerfanosBorrados = 0;
  for (const obj of objetos) {
    if (clavesEnBd.has(obj.name)) continue;
    // Huérfano: objeto sin fila. Solo si es viejo (no una subida en vuelo).
    if (ahora - obj.lastModified.getTime() < margenMs) continue;
    await minioClient.removeObject(env.MINIO_BUCKET, obj.name).catch((e) => {
      console.error(`[reconciliacion] no se pudo borrar el huérfano ${obj.name}:`, e);
    });
    huerfanosBorrados++;
    console.warn(`[reconciliacion] huérfano borrado de MinIO (sin fila): ${obj.name}`);
  }

  const colgadas = filas.filter((f) => !nombresEnMinio.has(f.claveMinio));
  if (colgadas.length > 0) {
    console.warn(
      `[reconciliacion] ${colgadas.length} fila(s) apuntan a objetos inexistentes en MinIO ` +
        `(binario perdido). Ejemplos: ${colgadas.slice(0, 5).map((c) => c.claveMinio).join(", ")}`,
    );
  }

  return { huerfanosBorrados, filasColgadas: colgadas.length };
};

// Retención: purga definitivamente lo que lleve más de RETENCION_PAPELERA_DIAS
// en la papelera. Opt-in (0 = desactivado). Reutiliza borrarPermanente para que
// limpie MinIO + BD + resúmenes igual que un borrado manual.
export const purgarPapeleraAntigua = async (
  dias: number = env.RETENCION_PAPELERA_DIAS,
): Promise<{ purgados: number }> => {
  if (dias <= 0) return { purgados: 0 };
  const corte = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const viejos = await archivoRepo().find({
    where: { eliminadoEn: LessThan(corte) },
    relations: { propietario: true },
    withDeleted: true,
  });
  let purgados = 0;
  for (const a of viejos) {
    await borrarPermanente(a.id, a.propietario.id).catch((e) =>
      console.error(`[reconciliacion] no se pudo purgar ${a.id}:`, e),
    );
    purgados++;
  }
  if (purgados > 0) {
    console.log(`[reconciliacion] retención: ${purgados} archivo(s) purgados de la papelera (> ${env.RETENCION_PAPELERA_DIAS}d).`);
  }
  return { purgados };
};

export const ejecutarMantenimiento = async (): Promise<void> => {
  try {
    const rec = await reconciliarMinioPostgres();
    await purgarPapeleraAntigua();
    if (rec.huerfanosBorrados > 0 || rec.filasColgadas > 0) {
      console.log(
        `[reconciliacion] hecho: ${rec.huerfanosBorrados} huérfano(s) borrados, ${rec.filasColgadas} fila(s) colgadas.`,
      );
    }
  } catch (e) {
    console.error("[reconciliacion] fallo en el mantenimiento:", e);
  }
};

let intervaloMantenimiento: NodeJS.Timeout | null = null;

// Arranca el mantenimiento periódico. Primera pasada poco después de arrancar
// (sin bloquear el arranque) y luego cada MANTENIMIENTO_INTERVAL_HORAS.
export const iniciarMantenimiento = (): void => {
  const periodoMs = env.MANTENIMIENTO_INTERVAL_HORAS * 60 * 60 * 1000;
  setTimeout(() => void ejecutarMantenimiento(), 30_000);
  intervaloMantenimiento = setInterval(() => void ejecutarMantenimiento(), periodoMs);
  console.log(
    `[reconciliacion] mantenimiento programado cada ${env.MANTENIMIENTO_INTERVAL_HORAS}h ` +
      `(retención papelera: ${env.RETENCION_PAPELERA_DIAS > 0 ? env.RETENCION_PAPELERA_DIAS + "d" : "desactivada"}).`,
  );
};

export const detenerMantenimiento = (): void => {
  if (intervaloMantenimiento) clearInterval(intervaloMantenimiento);
  intervaloMantenimiento = null;
};
