import { randomUUID, createHash } from "crypto";
import { Readable } from "stream";
import { IsNull } from "typeorm";
import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { minioClient } from "../config/minio";
import { AppError } from "../utils/errors";
import { env } from "../config/env";
import { z } from "zod";
import { crearCarpeta, normalizarRuta } from "./carpetas.service";
const repo = () => AppDataSource.getRepository(Archivo);

// --- SUBIR ARCHIVO ---
// Recibe el archivo en memoria (buffer de multer), lo sube a MinIO
// y guarda la metadata en Postgres.
// SHA-256 del contenido, para deduplicar (#4): subir dos veces el MISMO archivo
// guardaba dos copias y pagaba el OCR dos veces.
export const calcularHashSha256 = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

// Busca un archivo VIVO (no en papelera) del mismo usuario con idéntico hash.
// Si existe, la subida es un duplicado: se reutiliza en vez de reprocesar.
export const buscarArchivoPorHash = async (
  usuarioId: string,
  hash: string,
): Promise<Archivo | null> =>
  repo().findOne({
    where: {
      propietario: { id: usuarioId },
      hashSha256: hash,
      eliminadoEn: IsNull(),
      // Solo archivos PERSONALES: aunque el usuario conste como propietario de un
      // archivo que subió a una carpeta compartida, ese no es suyo personal y no
      // debe reutilizarse como dedup de una subida personal.
      carpetaCompartidaId: IsNull(),
    },
  });

export const subirArchivo = async (
  file: Express.Multer.File, // Objeto que multer adjunta al request
  carpeta: string, // Carpeta virtual, ej: "/facturas/2026"
  usuarioId: string,
  hashSha256?: string, // SHA-256 ya calculado (dedup); si no, se calcula aquí
): Promise<Archivo> => {
  // Normalizamos la carpeta: quitamos barras al inicio y al final
  const carpetaLimpia = carpeta.replace(/^\/|\/$/g, "") || "raiz";
  const carpetaFinal = carpetaLimpia === "raiz" ? "/" : `/${carpetaLimpia}`;

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
    carpeta: carpetaFinal,
    mimeType: file.mimetype,
    tamanoBytes: String(file.size),
    claveMinio: clave,
    hashSha256: hashSha256 ?? calcularHashSha256(file.buffer),
    propietario: { id: usuarioId } as Usuario,
  });

  // Si el guardado en Postgres falla, borramos el objeto que ya subimos a MinIO
  // para no dejar un binario huérfano (sin metadata que lo referencie).
  try {
    const guardado = await repo().save(archivo);
    // Persiste la carpeta como metadata explícita: si no, al borrar/mover este
    // archivo (el único que "creaba" la carpeta) la carpeta desaparecería de
    // los listados aunque el usuario la siga viendo como existente.
    if (carpetaFinal !== "/") await crearCarpeta(usuarioId, carpetaFinal);
    return guardado;
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
    .where("archivo.propietarioId = :usuarioId", { usuarioId })
    // Excluir lo que vive en una carpeta compartida: aunque el usuario conste como
    // propietario (autor/auditoría), NO es un archivo suyo personal.
    .andWhere("archivo.carpetaCompartidaId IS NULL");

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
    .where("archivo.propietarioId = :usuarioId", { usuarioId })
    .andWhere("archivo.carpetaCompartidaId IS NULL"); // solo archivos personales
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

// Combina el texto extraído automáticamente (OCR/PDF/DOCX) con la descripción
// manual del usuario (modal "¿Qué es esta imagen?"), cuando hay alguno de los
// dos. Se guardan en columnas separadas (`textoExtraido`/`descripcionManual`)
// para que ninguna sobrescriba a la otra según cuál termine antes — el OCR es
// en segundo plano y puede tardar más que rellenar el modal — y aquí se juntan
// en el momento de leer/indexar, siempre con el valor más reciente de las dos.
export const combinarContenido = (
  textoExtraido?: string | null,
  descripcionManual?: string | null,
): string => {
  const partes: string[] = [];
  const ocr = textoExtraido?.trim();
  const manual = descripcionManual?.trim();
  if (manual) partes.push(`Descripción: ${manual}`);
  // Si el OCR ya está copiado dentro de la descripción manual (el escaneo
  // manual de algo que no es factura lo guarda ahí como sustituto del modal de
  // descripción), no se repite por separado — mostrarlo dos veces es ruido, no
  // información nueva.
  if (ocr && !(manual && manual.includes(ocr))) partes.push(`Texto detectado (OCR):\n${ocr}`);
  return partes.join("\n\n");
};

// --- ELIMINAR ARCHIVO (soft delete → papelera) ---
// No borra el registro de Postgres ni el binario de MinIO.
// Solo rellena "eliminadoEn" con la fecha actual.
// Las queries normales ya no lo devolverán.
export const eliminarArchivo = async (
  id: string,
  usuarioId: string,
): Promise<void> => {
  // withDeleted: hace falta para poder distinguir "ya está en la papelera"
  // (no-op) de "no existe" (404) — ver comentario más abajo.
  const archivo = await repo().findOne({
    where: { id },
    relations: { propietario: true },
    withDeleted: true,
  });

  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso para eliminar este archivo");
  }
  // Idempotente: si ya está en la papelera, no es un error, ya se cumplió lo
  // que se pedía. Importante para el borrado múltiple del explorador: si una
  // misma petición del forkJoin intenta borrar dos veces, la segunda no debe
  // fallar con "Archivo no encontrado" y tumbar el resto de la operación.
  if (archivo.eliminadoEn) return;

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
  // Idempotente por la misma razón que en eliminarArchivo: si ya está activo,
  // no es un error.
  if (!archivo.eliminadoEn) return;

  // Si mientras estaba en la papelera se creó/subió otro archivo activo con el
  // mismo nombre en la misma carpeta (ej. se volvió a escanear la factura, o
  // se resubió el archivo), restaurar tal cual generaría un duplicado exacto
  // (incluido el registro de Factura asociado si es una factura, duplicando
  // los totales). Se le pone un sufijo automático en vez de chocar en silencio.
  let nombreFinal = archivo.nombre;
  let intento = 0;
  while (
    await repo().findOne({
      where: { nombre: nombreFinal, carpeta: archivo.carpeta, propietario: { id: usuarioId } },
    })
  ) {
    intento++;
    const punto = archivo.nombre.lastIndexOf(".");
    const base = punto > 0 ? archivo.nombre.slice(0, punto) : archivo.nombre;
    const ext = punto > 0 ? archivo.nombre.slice(punto) : "";
    nombreFinal = intento === 1 ? `${base} (restaurado)${ext}` : `${base} (restaurado ${intento})${ext}`;
  }
  if (nombreFinal !== archivo.nombre) {
    await repo().update(id, { nombre: nombreFinal });
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
    .andWhere("archivo.carpetaCompartidaId IS NULL") // los compartidos no van a papelera
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

  // Idempotente por la misma razón que en eliminarArchivo: si ya no existe, el
  // resultado que se pedía — que ya no exista — se cumple igual, no es un error.
  if (!archivo) return;
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
  // Normalizamos la carpeta (sin esto, "test" sin barra se guardaba literal
  // en vez de "/test", inconsistente con el resto del sistema).
  if (datos.carpeta) archivo.carpeta = normalizarRuta(datos.carpeta);

  const guardado = await repo().save(archivo);
  // Persiste la carpeta como metadata explícita: si no, al mover el único
  // archivo de una carpeta nueva y luego borrarlo, la carpeta desaparecería
  // de los listados (nunca existió como fila propia en "carpetas").
  if (archivo.carpeta !== "/") await crearCarpeta(usuarioId, archivo.carpeta);

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
  const carpetaFinal = carpetaLimpia === "raiz" ? "/" : `/${carpetaLimpia}`;
  const nuevaClave = `${usuarioId}/${carpetaLimpia}/${randomUUID()}`;

  // Nombre de la copia: si no se especifica uno, "<original> (copia)" -y
  // "(copia 2)", "(copia 3)"... si ya hay una copia con ese nombre en el
  // destino- igual que el copiar/pegar de un explorador de archivos normal.
  // Antes se reutilizaba el nombre EXACTO del original, dejando dos filas
  // idénticas (mismo nombre) en la misma carpeta, confuso en la UI.
  let nombreFinal = datos.nombre;
  if (!nombreFinal) {
    const punto = original.nombre.lastIndexOf(".");
    const base = punto > 0 ? original.nombre.slice(0, punto) : original.nombre;
    const ext = punto > 0 ? original.nombre.slice(punto) : "";
    let intento = 1;
    let candidato = `${base} (copia)${ext}`;
    while (
      await repo().findOne({
        where: { nombre: candidato, carpeta: carpetaFinal, propietario: { id: usuarioId } },
      })
    ) {
      intento++;
      candidato = `${base} (copia ${intento})${ext}`;
    }
    nombreFinal = candidato;
  }

  // Duplicamos el objeto en MinIO. La fuente se indica como "/bucket/clave".
  await minioClient.copyObject(
    env.MINIO_BUCKET,
    nuevaClave,
    `/${env.MINIO_BUCKET}/${original.claveMinio}`,
  );

  const copia = repo().create({
    nombre: nombreFinal,
    carpeta: carpetaFinal,
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
    if (carpetaFinal !== "/") await crearCarpeta(usuarioId, carpetaFinal);

    // NO se copia la Factura asociada a propósito: duplicar el registro haría que
    // la misma factura contara dos veces en la analítica (totales/ventas).
    delete (guardado as Partial<Archivo>).propietario;
    return guardado;
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, nuevaClave).catch(() => {});
    throw err;
  }
};
