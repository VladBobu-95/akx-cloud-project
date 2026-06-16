import { randomUUID } from "crypto";
import { Readable } from "stream";
import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { minioClient } from "../config/minio";
import { AppError } from "../utils/errors";
import { env } from "../config/env";
import { z } from "zod";

const repo = () => AppDataSource.getRepository(Archivo);

// --- SUBIR ARCHIVO ---
// Recibe el archivo en memoria (buffer de multer), lo sube a MinIO
// y guarda la metadata en Postgres.
export const subirArchivo = async (
  file: Express.Multer.File, // Objeto que multer adjunta al request
  carpeta: string, // Carpeta virtual, ej: "/facturas/2026"
  usuarioId: string,
): Promise<Archivo> => {
  // Normalizamos la carpeta: quitamos barras al inicio y al final
  const carpetaLimpia = carpeta.replace(/^\/|\/$/g, "") || "raiz";

  // Generamos una clave única para el objeto en MinIO.
  // Estructura: usuarioId/carpeta/uuid  (así cada usuario tiene su "directorio")
  const clave = `${usuarioId}/${carpetaLimpia}/${randomUUID()}`;

  // Convertimos el Buffer a un Stream legible para MinIO
  const stream = Readable.from(file.buffer);

  // Subimos el archivo a MinIO con metadata del tipo de archivo
  await minioClient.putObject(env.MINIO_BUCKET, clave, stream, file.size, {
    "Content-Type": file.mimetype,
  });

  // Guardamos en Postgres SOLO la metadata (nombre, tamaño, carpeta, clave de MinIO...)
  // El archivo binario real vive en MinIO, no en la BD.
  // La raíz se guarda como "/" (no "/raiz") para que los archivos sin carpeta
  // aparezcan en la raíz del explorador; "raiz" solo se usa en la clave MinIO.
  const archivo = repo().create({
    nombre: file.originalname,
    carpeta: carpetaLimpia === "raiz" ? "/" : `/${carpetaLimpia}`,
    mimeType: file.mimetype,
    tamanoBytes: String(file.size),
    claveMinio: clave,
    propietario: { id: usuarioId } as Usuario,
  });

  // Si el guardado en Postgres falla, borramos el objeto que ya subimos a MinIO
  // para no dejar un binario huérfano (sin metadata que lo referencie).
  try {
    return await repo().save(archivo);
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, clave).catch(() => {});
    throw err;
  }
};

// --- LISTAR ARCHIVOS CON PAGINACIÓN ---
// Devuelve los archivos paginados y el total para que el cliente
// sepa cuántas páginas hay en total.
export const listarArchivos = async (
  usuarioId: string,
  carpeta?: string,
  pagina: number = 1,
  limite: number = 20,
): Promise<{ archivos: Archivo[]; total: number; paginas: number }> => {
  const query = repo()
    .createQueryBuilder("archivo")
    .where("archivo.propietarioId = :usuarioId", { usuarioId });

  if (carpeta) {
    query.andWhere("archivo.carpeta = :carpeta", { carpeta });
  }

  query.orderBy("archivo.subidoEn", "DESC");

  // skip: cuántos registros saltar (ej: pagina 2, limite 20 → skip 20)
  // take: cuántos registros coger
  query.skip((pagina - 1) * limite).take(limite);

  // getManyAndCount devuelve [archivos, total] en una sola query
  const [archivos, total] = await query.getManyAndCount();

  return {
    archivos,
    total,
    paginas: Math.ceil(total / limite), // total de páginas disponibles
  };
};

// --- PREPARAR DESCARGA DE CARPETA (ZIP) ---
// Reúne todos los archivos del usuario cuyo `carpeta` es `ruta` o cuelga de ella
// (subárbol) y devuelve, por cada uno, un stream de MinIO y su ruta relativa
// dentro del zip (conservando las subcarpetas). El controlador construye el zip.
export const prepararDescargaCarpeta = async (
  usuarioId: string,
  ruta: string,
): Promise<{ nombreZip: string; entradas: { name: string; stream: Readable }[] }> => {
  // Normalizamos la ruta a la forma canónica "/a/b" ("/" = raíz).
  const limpia = ruta.replace(/^\/+|\/+$/g, "");
  const rutaNorm = limpia ? `/${limpia}` : "/";

  const query = repo()
    .createQueryBuilder("archivo")
    .where("archivo.propietarioId = :usuarioId", { usuarioId });
  if (rutaNorm === "/") {
    // Toda la cuenta.
  } else {
    query.andWhere("(archivo.carpeta = :ruta OR archivo.carpeta LIKE :prefijo)", {
      ruta: rutaNorm,
      prefijo: `${rutaNorm}/%`,
    });
  }
  const archivos = await query.getMany();

  const entradas = await Promise.all(
    archivos.map(async (a) => {
      const carpetaArchivo = a.carpeta.replace(/^\/+|\/+$/g, "");
      const base = rutaNorm === "/" ? "" : limpia; // prefijo a quitar
      // Ruta relativa de la subcarpeta dentro del zip (sin el prefijo de `ruta`).
      let rel = carpetaArchivo;
      if (base && (rel === base || rel.startsWith(`${base}/`))) {
        rel = rel.slice(base.length).replace(/^\/+/, "");
      }
      const name = rel ? `${rel}/${a.nombre}` : a.nombre;
      const stream = await minioClient.getObject(env.MINIO_BUCKET, a.claveMinio);
      return { name, stream };
    }),
  );

  const nombreZip = `${limpia ? limpia.split("/").pop() : "mis-archivos"}.zip`;
  return { nombreZip, entradas };
};

// --- CREAR ARCHIVO DE TEXTO (p. ej. .md) DESDE UNA CADENA ---
// Sube a MinIO un archivo de texto generado en el servidor (lo usa el chatbot
// para crear notas/.md). Igual que subirArchivo pero el contenido viene como string.
export const crearArchivoTexto = async (
  usuarioId: string,
  nombre: string,
  carpeta: string,
  contenido: string,
): Promise<Archivo> => {
  const carpetaLimpia = (carpeta ?? "").replace(/^\/|\/$/g, "") || "raiz";
  const clave = `${usuarioId}/${carpetaLimpia}/${randomUUID()}`;
  const buffer = Buffer.from(contenido ?? "", "utf8");
  const mimeType = nombre.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";

  await minioClient.putObject(env.MINIO_BUCKET, clave, Readable.from(buffer), buffer.length, {
    "Content-Type": mimeType,
  });

  const archivo = repo().create({
    nombre,
    carpeta: carpetaLimpia === "raiz" ? "/" : `/${carpetaLimpia}`,
    mimeType,
    tamanoBytes: String(buffer.length),
    claveMinio: clave,
    propietario: { id: usuarioId } as Usuario,
  });

  try {
    return await repo().save(archivo);
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, clave).catch(() => {});
    throw err;
  }
};

// --- BUSCAR ARCHIVOS POR NOMBRE ---
// Búsqueda simple por nombre (case-insensitive). La usa el chatbot para
// localizar archivos por lo que dice el usuario y obtener su id.
export const buscarArchivos = async (
  usuarioId: string,
  q: string,
  limite: number = 20,
): Promise<Archivo[]> => {
  return repo()
    .createQueryBuilder("archivo")
    .where("archivo.propietarioId = :usuarioId", { usuarioId })
    .andWhere("archivo.nombre ILIKE :q", { q: `%${q}%` })
    .orderBy("archivo.subidoEn", "DESC")
    .take(limite)
    .getMany();
};

// --- DESCARGAR ARCHIVO (streaming a través de la API) ---
// Devolvemos la metadata + un stream del objeto en MinIO. El controlador lo
// canaliza hacia el cliente. Hacerlo así (en vez de redirigir a una URL firmada)
// permite que la descarga funcione desde el navegador en cualquier entorno: la
// URL firmada apuntaría al endpoint INTERNO de MinIO (p.ej. "minio:9000" en Docker),
// que el navegador no puede resolver.
export const descargarArchivo = async (
  id: string,
  usuarioId: string,
): Promise<{ archivo: Archivo; stream: Readable }> => {
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");

  // Verificamos que el archivo pertenece al usuario que hace la petición
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para acceder a este archivo");
  }

  const stream = await minioClient.getObject(env.MINIO_BUCKET, archivo.claveMinio);
  return { archivo, stream };
};

// --- LEER TEXTO DE UN ARCHIVO (para el chatbot) ---
// Devuelve el contenido como string si es un archivo de texto (texto/markdown/csv/json),
// truncado a maxChars. Lanza error si no es texto.
export const leerTextoArchivo = async (
  id: string,
  usuarioId: string,
  maxChars = 4000,
): Promise<string> => {
  const { archivo, stream } = await descargarArchivo(id, usuarioId);
  const esTexto = /^(text\/|application\/(json|xml|markdown))/.test(archivo.mimeType);
  if (!esTexto) {
    stream.destroy();
    throw new AppError(400, "El archivo no es de texto, no puedo leer su contenido.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const buf = c as Buffer;
    chunks.push(buf);
    total += buf.length;
    if (total >= maxChars * 4) break; // suficiente para maxChars caracteres
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxChars);
};

// --- ESTADÍSTICAS DEL USUARIO (para el chatbot) ---
export const estadisticasUsuario = async (
  usuarioId: string,
): Promise<{ numArchivos: number; espacioBytes: number }> => {
  const fila = await repo()
    .createQueryBuilder("archivo")
    .select("COUNT(*)", "num")
    .addSelect("COALESCE(SUM(archivo.tamanoBytes), 0)", "bytes")
    .where("archivo.propietarioId = :usuarioId", { usuarioId })
    .getRawOne<{ num: string; bytes: string }>();
  return {
    numArchivos: Number(fila?.num ?? 0),
    espacioBytes: Number(fila?.bytes ?? 0),
  };
};

// --- ELIMINAR ARCHIVO (soft delete → papelera) ---
// No borra el registro de Postgres ni el binario de MinIO.
// Solo rellena "eliminadoEn" con la fecha actual.
// Las queries normales ya no lo devolverán.
export const eliminarArchivo = async (
  id: string,
  usuarioId: string,
): Promise<void> => {
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para eliminar este archivo");
  }

  // softRemove rellena eliminadoEn en vez de borrar la fila
  await repo().softRemove(archivo);
};

// --- RESTAURAR ARCHIVO (sacar de la papelera) ---
export const restaurarArchivo = async (
  id: string,
  usuarioId: string,
): Promise<void> => {
  // withDeleted: incluye en la búsqueda los registros soft-deleted
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
    withDeleted: true,
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para restaurar este archivo");
  }
  if (!archivo.eliminadoEn) {
    throw new AppError(400, "El archivo no está en la papelera");
  }

  // restore pone eliminadoEn a null → vuelve a aparecer en las queries normales
  await repo().restore(id);
};

// --- LISTAR PAPELERA ---
// Devuelve solo los archivos eliminados del usuario
export const listarPapelera = async (usuarioId: string): Promise<Archivo[]> => {
  return repo()
    .createQueryBuilder("archivo")
    .where("archivo.propietarioId = :usuarioId", { usuarioId })
    .andWhere("archivo.eliminadoEn IS NOT NULL")
    .withDeleted() // necesario para que incluya los soft-deleted
    .orderBy("archivo.eliminadoEn", "DESC")
    .getMany();
};

// --- BORRAR PERMANENTE (sin vuelta atrás) ---
// A diferencia de eliminarArchivo (soft delete), esto borra el binario de MinIO
// y la fila de Postgres definitivamente. Sirve para "borrar de la papelera".
export const borrarPermanente = async (
  id: string,
  usuarioId: string,
): Promise<void> => {
  // withDeleted para encontrarlo aunque esté en la papelera (soft-deleted)
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
    withDeleted: true,
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para borrar este archivo");
  }

  // Primero MinIO (idempotente: no falla si la clave ya no existe), luego Postgres.
  await minioClient.removeObject(env.MINIO_BUCKET, archivo.claveMinio);
  await repo().delete(id); // hard delete: funciona aunque esté soft-deleted
};

// --- VACIAR PAPELERA ---
// Borra permanentemente TODOS los archivos que el usuario tiene en la papelera,
// tanto el binario en MinIO como la fila en Postgres.
export const vaciarPapelera = async (
  usuarioId: string,
): Promise<{ borrados: number }> => {
  const archivos = await listarPapelera(usuarioId);
  if (archivos.length === 0) return { borrados: 0 };

  const claves = archivos.map((a) => a.claveMinio);
  const ids = archivos.map((a) => a.id);

  // removeObjects borra en lote (idempotente con claves inexistentes)
  await minioClient.removeObjects(env.MINIO_BUCKET, claves);
  await repo().delete(ids); // hard delete de todas las filas soft-deleted

  return { borrados: archivos.length };
};

// --- OBTENER INFO DE UN ARCHIVO ---
export const obtenerArchivo = async (
  id: string,
  usuarioId: string,
): Promise<Archivo> => {
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");

  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para ver este archivo");
  }

  // El propietario solo se carga para comprobar el permiso. NO debe llegar al
  // cliente porque incluye el passwordHash. Lo quitamos antes de devolver.
  delete (archivo as Partial<Archivo>).propietario;
  return archivo;
};

// Schema de validación para actualizar archivo
// Ambos campos son opcionales: puedes renombrar, mover, o ambas cosas a la vez
export const schemaActualizarArchivo = z.object({
  nombre: z.string().min(1).optional(),
  carpeta: z.string().optional(),
});

// --- ACTUALIZAR ARCHIVO (renombrar / mover) ---
// No toca MinIO: la clave del objeto no cambia, solo la metadata en Postgres
export const actualizarArchivo = async (
  id: string,
  usuarioId: string,
  datos: z.infer<typeof schemaActualizarArchivo>,
): Promise<Archivo> => {
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para modificar este archivo");
  }

  // Solo actualizamos los campos que llegan — si no llega nombre, no lo tocamos
  if (datos.nombre) archivo.nombre = datos.nombre;
  if (datos.carpeta) archivo.carpeta = datos.carpeta;

  const guardado = await repo().save(archivo);

  // Igual que en obtenerArchivo: no devolvemos el propietario (lleva passwordHash).
  delete (guardado as Partial<Archivo>).propietario;
  return guardado;
};

// Schema de validación para copiar archivo: carpeta destino y nombre opcionales
export const schemaCopiarArchivo = z.object({
  carpeta: z.string().optional(),
  nombre: z.string().min(1).optional(),
});

// --- COPIAR ARCHIVO ---
// Duplica el binario en MinIO (copyObject) y crea una nueva fila de metadata.
// A diferencia de mover (actualizar), aquí SÍ se crea un objeto nuevo en MinIO.
export const copiarArchivo = async (
  id: string,
  usuarioId: string,
  datos: z.infer<typeof schemaCopiarArchivo>,
): Promise<Archivo> => {
  const original = await repo().findOne({
    where: { id },
    relations: { propietario: true },
  });

  if (!original) throw new AppError(404, "Archivo no encontrado");
  if (original.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para copiar este archivo");
  }

  // Carpeta destino: la indicada o la misma del original. Normalizamos igual que
  // al subir (sin barras al inicio/fin); "" → raíz.
  const carpetaDestino = datos.carpeta ?? original.carpeta;
  const carpetaLimpia = carpetaDestino.replace(/^\/|\/$/g, "") || "raiz";
  const nuevaClave = `${usuarioId}/${carpetaLimpia}/${randomUUID()}`;

  // Duplicamos el objeto en MinIO. La fuente se indica como "/bucket/clave".
  await minioClient.copyObject(
    env.MINIO_BUCKET,
    nuevaClave,
    `/${env.MINIO_BUCKET}/${original.claveMinio}`,
  );

  const copia = repo().create({
    nombre: datos.nombre ?? original.nombre,
    carpeta: carpetaLimpia === "raiz" ? "/" : `/${carpetaLimpia}`,
    mimeType: original.mimeType,
    tamanoBytes: original.tamanoBytes,
    claveMinio: nuevaClave,
    hashSha256: original.hashSha256,
    textoExtraido: original.textoExtraido,
    propietario: { id: usuarioId } as Usuario,
  });

  // Si falla el guardado en Postgres, borramos el binario copiado para no dejar
  // un objeto huérfano en MinIO.
  try {
    const guardado = await repo().save(copia);
    delete (guardado as Partial<Archivo>).propietario;
    return guardado;
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, nuevaClave).catch(() => {});
    throw err;
  }
};
