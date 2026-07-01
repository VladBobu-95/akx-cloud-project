import { randomUUID } from "crypto";
import { Readable } from "stream";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../config/database";
import { CarpetaCompartida } from "../entities/CarpetaCompartida";
import { CarpetaCompartidaCarpeta } from "../entities/CarpetaCompartidaCarpeta";
import { Rol } from "../entities/Rol";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { minioClient } from "../config/minio";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { calcularHashSha256 } from "./archivos.service";

// Carpetas compartidas por rol. El admin las crea y decide qué roles acceden; los
// miembros con esos roles ven/usan los archivos (almacenamiento ÚNICO: lo que
// sube uno lo ven todos los del rol). Acceso por empresa+roles, NO por propietario.

const ccRepo = () => AppDataSource.getRepository(CarpetaCompartida);
const ccCarpetaRepo = () => AppDataSource.getRepository(CarpetaCompartidaCarpeta);
const rolRepo = () => AppDataSource.getRepository(Rol);
const usuarioRepo = () => AppDataSource.getRepository(Usuario);
const archivoRepo = () => AppDataSource.getRepository(Archivo);

// ===================== ADMIN: CRUD =====================

export const schemaCrearCarpetaCompartida = z.object({
  nombre: z.string().min(1, "el nombre es obligatorio"),
  rolesIds: z.array(z.string().uuid()).default([]),
});

export const schemaActualizarCarpetaCompartida = z.object({
  nombre: z.string().min(1).optional(),
  rolesIds: z.array(z.string().uuid()).optional(),
});

const resolverRoles = async (empresaId: string, rolesIds: string[]): Promise<Rol[]> => {
  if (rolesIds.length === 0) return [];
  const roles = await rolRepo().findBy({ id: In(rolesIds), empresaId });
  if (roles.length !== new Set(rolesIds).size) {
    throw new AppError(400, "Algún rol no existe o no pertenece a tu empresa");
  }
  return roles;
};

export const listarCarpetasAdmin = (empresaId: string): Promise<CarpetaCompartida[]> =>
  ccRepo().find({ where: { empresaId }, relations: { roles: true }, order: { nombre: "ASC" } });

export const crearCarpetaCompartida = async (
  empresaId: string,
  datos: z.infer<typeof schemaCrearCarpetaCompartida>,
): Promise<CarpetaCompartida> => {
  const existe = await ccRepo().findOneBy({ empresaId, nombre: datos.nombre });
  if (existe) throw new AppError(409, "Ya existe una carpeta compartida con ese nombre");
  const roles = await resolverRoles(empresaId, datos.rolesIds);
  const carpeta = ccRepo().create({ empresaId, nombre: datos.nombre, roles });
  return ccRepo().save(carpeta);
};

export const actualizarCarpetaCompartida = async (
  empresaId: string,
  id: string,
  datos: z.infer<typeof schemaActualizarCarpetaCompartida>,
): Promise<CarpetaCompartida> => {
  const carpeta = await ccRepo().findOne({ where: { id, empresaId }, relations: { roles: true } });
  if (!carpeta) throw new AppError(404, "Carpeta compartida no encontrada");

  if (datos.nombre !== undefined && datos.nombre !== carpeta.nombre) {
    const choca = await ccRepo().findOneBy({ empresaId, nombre: datos.nombre });
    if (choca) throw new AppError(409, "Ya existe una carpeta compartida con ese nombre");
    carpeta.nombre = datos.nombre;
  }
  if (datos.rolesIds !== undefined) {
    carpeta.roles = await resolverRoles(empresaId, datos.rolesIds);
  }
  return ccRepo().save(carpeta);
};

export const eliminarCarpetaCompartida = async (empresaId: string, id: string): Promise<void> => {
  const carpeta = await ccRepo().findOneBy({ id, empresaId });
  if (!carpeta) throw new AppError(404, "Carpeta compartida no encontrada");
  // Los archivos dentro se borran por el FK ON DELETE CASCADE; limpiamos sus
  // binarios en MinIO antes para no dejar huérfanos.
  const archivos = await archivoRepo().find({
    where: { carpetaCompartidaId: id },
    withDeleted: true,
  });
  await Promise.all(
    archivos.map((a) => minioClient.removeObject(env.MINIO_BUCKET, a.claveMinio).catch(() => {})),
  );
  await ccRepo().remove(carpeta);
};

// ===================== ACCESO =====================

// Carpetas compartidas a las que el usuario tiene acceso: admin → todas las de su
// empresa; miembro → las que incluyan alguno de sus roles.
export const carpetasAccesibles = async (usuarioId: string): Promise<CarpetaCompartida[]> => {
  const usuario = await usuarioRepo().findOne({
    where: { id: usuarioId },
    relations: { roles: true },
  });
  if (!usuario || !usuario.empresaId) return [];

  if (usuario.rol === "admin" || usuario.rol === "superadmin") {
    return ccRepo().find({
      where: { empresaId: usuario.empresaId },
      relations: { roles: true },
      order: { nombre: "ASC" },
    });
  }

  const rolesIds = (usuario.roles ?? []).map((r) => r.id);
  if (rolesIds.length === 0) return [];

  return ccRepo()
    .createQueryBuilder("cc")
    .innerJoin("cc.roles", "rol", "rol.id IN (:...rolesIds)", { rolesIds })
    .where("cc.empresaId = :empresaId", { empresaId: usuario.empresaId })
    .orderBy("cc.nombre", "ASC")
    .getMany();
};

export const idsCompartidasAccesibles = async (usuarioId: string): Promise<string[]> =>
  (await carpetasAccesibles(usuarioId)).map((c) => c.id);

// Verifica que el usuario puede acceder a esa carpeta compartida; devuelve la carpeta.
const verificarAcceso = async (
  usuarioId: string,
  carpetaCompartidaId: string,
): Promise<CarpetaCompartida> => {
  const accesibles = await carpetasAccesibles(usuarioId);
  const carpeta = accesibles.find((c) => c.id === carpetaCompartidaId);
  if (!carpeta) throw new AppError(403, "No tienes acceso a esta carpeta compartida");
  return carpeta;
};

// ===================== ARCHIVOS COMPARTIDOS =====================

const normalizarCarpeta = (carpeta?: string): string => {
  const limpia = (carpeta ?? "").replace(/^\/+|\/+$/g, "");
  return limpia ? `/${limpia}` : "/";
};

// Lista los archivos de una carpeta compartida en la ruta dada + las subcarpetas
// inmediatas (derivadas de las rutas de los archivos).
export const listarArchivosCompartidos = async (
  usuarioId: string,
  carpetaCompartidaId: string,
  carpeta?: string,
): Promise<{ archivos: Archivo[]; subcarpetas: string[] }> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const rutaActual = normalizarCarpeta(carpeta);

  const todos = await archivoRepo().find({
    where: { carpetaCompartidaId },
    order: { subidoEn: "DESC" },
  });

  const archivos = todos.filter((a) => a.carpeta === rutaActual);

  // Subcarpetas inmediatas: prefijo = rutaActual; el primer segmento siguiente.
  const prefijo = rutaActual === "/" ? "/" : `${rutaActual}/`;
  const hijas = new Set<string>();
  for (const a of todos) {
    if (a.carpeta === rutaActual) continue;
    if (rutaActual !== "/" && !a.carpeta.startsWith(prefijo)) continue;
    const resto = a.carpeta.slice(prefijo.length).replace(/^\/+/, "");
    if (!resto) continue;
    const primer = resto.split("/")[0];
    hijas.add(rutaActual === "/" ? `/${primer}` : `${rutaActual}/${primer}`);
  }

  return { archivos, subcarpetas: [...hijas].sort() };
};

// Dedup por (carpeta compartida, hash): subir el mismo contenido no duplica ni
// reprocesa (escaneo único). Devuelve el existente si lo hay.
const buscarCompartidoPorHash = (carpetaCompartidaId: string, hash: string): Promise<Archivo | null> =>
  archivoRepo()
    .createQueryBuilder("a")
    .where("a.carpetaCompartidaId = :carpetaCompartidaId", { carpetaCompartidaId })
    .andWhere("a.hashSha256 = :hash", { hash })
    .andWhere("a.eliminadoEn IS NULL")
    .getOne();

export const subirCompartido = async (
  file: Express.Multer.File,
  usuarioId: string,
  carpetaCompartidaId: string,
  carpeta?: string,
): Promise<{ archivo: Archivo; duplicado: boolean }> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);

  const hash = calcularHashSha256(file.buffer);
  const existente = await buscarCompartidoPorHash(carpetaCompartidaId, hash);
  if (existente) return { archivo: existente, duplicado: true };

  const carpetaFinal = normalizarCarpeta(carpeta);
  const carpetaLimpia = carpetaFinal === "/" ? "raiz" : carpetaFinal.slice(1);
  const clave = `compartido/${carpetaCompartidaId}/${carpetaLimpia}/${randomUUID()}`;

  await minioClient.putObject(env.MINIO_BUCKET, clave, Readable.from(file.buffer), file.size, {
    "Content-Type": file.mimetype,
  });

  const archivo = archivoRepo().create({
    nombre: file.originalname,
    carpeta: carpetaFinal,
    mimeType: file.mimetype,
    tamanoBytes: String(file.size),
    claveMinio: clave,
    hashSha256: hash,
    propietario: { id: usuarioId } as Usuario, // autor/auditoría
    carpetaCompartidaId,
  });

  try {
    const guardado = await archivoRepo().save(archivo);
    return { archivo: guardado, duplicado: false };
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, clave).catch(() => {});
    throw err;
  }
};

// Carga un archivo compartido verificando acceso por su carpeta compartida.
const cargarCompartidoConAcceso = async (archivoId: string, usuarioId: string): Promise<Archivo> => {
  const archivo = await archivoRepo().findOneBy({ id: archivoId });
  if (!archivo || !archivo.carpetaCompartidaId) {
    throw new AppError(404, "Archivo compartido no encontrado");
  }
  await verificarAcceso(usuarioId, archivo.carpetaCompartidaId);
  return archivo;
};

export const descargarCompartido = async (
  archivoId: string,
  usuarioId: string,
): Promise<{ archivo: Archivo; stream: Readable }> => {
  const archivo = await cargarCompartidoConAcceso(archivoId, usuarioId);
  const stream = await minioClient.getObject(env.MINIO_BUCKET, archivo.claveMinio);
  return { archivo, stream };
};

// Borra un archivo compartido (definitivo): afecta a todos los del rol. Los
// compartidos no van a la papelera personal de nadie.
export const eliminarCompartido = async (archivoId: string, usuarioId: string): Promise<void> => {
  const archivo = await cargarCompartidoConAcceso(archivoId, usuarioId);
  await minioClient.removeObject(env.MINIO_BUCKET, archivo.claveMinio).catch(() => {});
  // Los fragmentos RAG del archivo se borran solos por el FK ON DELETE CASCADE
  // (FK_fragmentos_archivo), igual que en el borrado permanente personal.
  await archivoRepo().delete(archivo.id);
};

// ===================== EXPLORADOR COMPLETO (paridad con "Mis archivos") =====================
// Estas funciones dan a las carpetas compartidas las mismas operaciones que el
// explorador personal: árbol de subcarpetas persistidas (incluidas las vacías),
// mover/renombrar/copiar archivos y carpetas, y descarga en .zip. El acceso lo
// sigue gobernando la carpeta compartida (empresa+roles), no un propietario.

// Todos los archivos de una carpeta compartida (para construir el árbol en cliente,
// igual que listarTodos de personal).
export const listarTodosCompartidos = async (
  usuarioId: string,
  carpetaCompartidaId: string,
): Promise<Archivo[]> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  return archivoRepo().find({
    where: { carpetaCompartidaId },
    order: { subidoEn: "DESC" },
  });
};

// Subcarpetas EXPLÍCITAS persistidas (incluidas las vacías) de una carpeta compartida.
export const listarSubcarpetasCompartidas = async (
  usuarioId: string,
  carpetaCompartidaId: string,
): Promise<{ ruta: string; creada: string }[]> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const filas = await ccCarpetaRepo().find({
    where: { carpetaCompartidaId },
    order: { ruta: "ASC" },
  });
  return filas.map((c) => ({ ruta: c.ruta, creada: c.creadaEn.toISOString() }));
};

// Crea una subcarpeta (idempotente). Devuelve la ruta canónica.
export const crearSubcarpetaCompartida = async (
  usuarioId: string,
  carpetaCompartidaId: string,
  ruta: string,
): Promise<string> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const r = normalizarCarpeta(ruta);
  if (r === "/") throw new AppError(400, "No se puede crear la carpeta raíz");
  const existe = await ccCarpetaRepo().findOneBy({ carpetaCompartidaId, ruta: r });
  if (!existe) {
    try {
      await ccCarpetaRepo().save(ccCarpetaRepo().create({ carpetaCompartidaId, ruta: r }));
    } catch (err: unknown) {
      // 23505 = unique_violation por creación concurrente; idempotente, se ignora.
      const code =
        (err as { code?: string; driverError?: { code?: string } })?.code ??
        (err as { driverError?: { code?: string } })?.driverError?.code;
      if (code !== "23505") throw err;
    }
  }
  return r;
};

// Borra la metadata de una subcarpeta y sus descendientes (NO borra archivos: el
// llamador los borra aparte, igual que el explorador personal).
export const eliminarSubcarpetaCompartida = async (
  usuarioId: string,
  carpetaCompartidaId: string,
  ruta: string,
): Promise<void> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const r = normalizarCarpeta(ruta);
  await ccCarpetaRepo()
    .createQueryBuilder()
    .delete()
    .from(CarpetaCompartidaCarpeta)
    .where("carpetaCompartidaId = :cc", { cc: carpetaCompartidaId })
    .andWhere("(ruta = :r OR ruta LIKE :p)", { r, p: `${r}/%` })
    .execute();
};

// Mueve/renombra una subcarpeta CON su contenido: re-prefija la ruta de todos los
// archivos del subárbol y de la metadata de subcarpetas.
export const reubicarSubcarpetaCompartida = async (
  usuarioId: string,
  carpetaCompartidaId: string,
  origen: string,
  destino: string,
): Promise<void> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const o = normalizarCarpeta(origen);
  const d = normalizarCarpeta(destino);
  if (d === o || d.startsWith(`${o}/`)) {
    throw new AppError(400, "No puedes mover una carpeta dentro de sí misma");
  }

  const archivos = await archivoRepo()
    .createQueryBuilder("a")
    .where("a.carpetaCompartidaId = :cc", { cc: carpetaCompartidaId })
    .andWhere("(a.carpeta = :o OR a.carpeta LIKE :p)", { o, p: `${o}/%` })
    .getMany();
  for (const a of archivos) a.carpeta = d + a.carpeta.slice(o.length);
  if (archivos.length) await archivoRepo().save(archivos);

  const metas = await ccCarpetaRepo()
    .createQueryBuilder("c")
    .where("c.carpetaCompartidaId = :cc", { cc: carpetaCompartidaId })
    .andWhere("(c.ruta = :o OR c.ruta LIKE :p)", { o, p: `${o}/%` })
    .getMany();
  for (const c of metas) c.ruta = d + c.ruta.slice(o.length);
  if (metas.length) await ccCarpetaRepo().save(metas);

  // Garantiza que la carpeta destino exista como metadata (aunque quede vacía).
  await crearSubcarpetaCompartida(usuarioId, carpetaCompartidaId, d);
};

// Renombra/mueve un archivo compartido DENTRO de su misma carpeta compartida.
export const actualizarArchivoCompartido = async (
  archivoId: string,
  usuarioId: string,
  datos: { nombre?: string; carpeta?: string },
): Promise<Archivo> => {
  const archivo = await cargarCompartidoConAcceso(archivoId, usuarioId);
  if (datos.nombre !== undefined) archivo.nombre = datos.nombre;
  if (datos.carpeta !== undefined) archivo.carpeta = normalizarCarpeta(datos.carpeta);
  return archivoRepo().save(archivo);
};

// Copia un archivo compartido (binario incluido) dentro de la misma carpeta
// compartida. Duplica también sus fragmentos RAG (reutilizando embeddings).
export const copiarArchivoCompartido = async (
  archivoId: string,
  usuarioId: string,
  datos: { carpeta?: string; nombre?: string },
): Promise<Archivo> => {
  const original = await cargarCompartidoConAcceso(archivoId, usuarioId);
  const carpetaCompartidaId = original.carpetaCompartidaId!;

  const carpetaFinal = normalizarCarpeta(datos.carpeta ?? original.carpeta);
  const carpetaLimpia = carpetaFinal === "/" ? "raiz" : carpetaFinal.slice(1);
  const nuevaClave = `compartido/${carpetaCompartidaId}/${carpetaLimpia}/${randomUUID()}`;

  // Nombre de la copia: "<original> (copia)", "(copia 2)"... si ya existe en el destino.
  let nombreFinal = datos.nombre;
  if (!nombreFinal) {
    const punto = original.nombre.lastIndexOf(".");
    const base = punto > 0 ? original.nombre.slice(0, punto) : original.nombre;
    const ext = punto > 0 ? original.nombre.slice(punto) : "";
    let intento = 1;
    let candidato = `${base} (copia)${ext}`;
    while (
      await archivoRepo().findOne({
        where: { nombre: candidato, carpeta: carpetaFinal, carpetaCompartidaId },
      })
    ) {
      intento++;
      candidato = `${base} (copia ${intento})${ext}`;
    }
    nombreFinal = candidato;
  }

  await minioClient.copyObject(
    env.MINIO_BUCKET,
    nuevaClave,
    `/${env.MINIO_BUCKET}/${original.claveMinio}`,
  );

  const copia = archivoRepo().create({
    nombre: nombreFinal,
    carpeta: carpetaFinal,
    mimeType: original.mimeType,
    tamanoBytes: original.tamanoBytes,
    claveMinio: nuevaClave,
    hashSha256: original.hashSha256,
    textoExtraido: original.textoExtraido,
    propietario: { id: usuarioId } as Usuario, // autor/auditoría
    carpetaCompartidaId,
  });

  try {
    const guardado = await archivoRepo().save(copia);
    // Duplicamos los fragmentos RAG (incl. carpetaCompartidaId) para que la copia
    // también aparezca en la búsqueda; reutiliza los embeddings ya calculados.
    try {
      await AppDataSource.query(
        `INSERT INTO "fragmentos" ("archivoId", "propietarioId", "carpetaCompartidaId", "indice", "texto", "embedding")
         SELECT $1, "propietarioId", "carpetaCompartidaId", "indice", "texto", "embedding"
         FROM "fragmentos" WHERE "archivoId" = $2`,
        [guardado.id, original.id],
      );
    } catch (errFrag) {
      console.error(`Error copiando fragmentos RAG de "${original.nombre}":`, errFrag);
    }
    return guardado;
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, nuevaClave).catch(() => {});
    throw err;
  }
};

// Prepara el .zip de una subcarpeta compartida (o de toda la carpeta si ruta = "/"),
// conservando las subcarpetas. El controlador construye el zip con los streams.
export const prepararDescargaCarpetaCompartida = async (
  usuarioId: string,
  carpetaCompartidaId: string,
  ruta: string,
): Promise<{ nombreZip: string; entradas: { name: string; stream: Readable }[] }> => {
  const carpeta = await verificarAcceso(usuarioId, carpetaCompartidaId);
  const rutaNorm = normalizarCarpeta(ruta);
  const limpia = rutaNorm === "/" ? "" : rutaNorm.slice(1);

  const query = archivoRepo()
    .createQueryBuilder("a")
    .where("a.carpetaCompartidaId = :cc", { cc: carpetaCompartidaId });
  if (rutaNorm !== "/") {
    query.andWhere("(a.carpeta = :r OR a.carpeta LIKE :p)", { r: rutaNorm, p: `${rutaNorm}/%` });
  }
  const archivos = await query.getMany();

  const entradas = await Promise.all(
    archivos.map(async (a) => {
      const carpetaArchivo = a.carpeta.replace(/^\/+|\/+$/g, "");
      let rel = carpetaArchivo;
      if (limpia && (rel === limpia || rel.startsWith(`${limpia}/`))) {
        rel = rel.slice(limpia.length).replace(/^\/+/, "");
      }
      const name = rel ? `${rel}/${a.nombre}` : a.nombre;
      const stream = await minioClient.getObject(env.MINIO_BUCKET, a.claveMinio);
      return { name, stream };
    }),
  );

  const base = rutaNorm === "/" ? carpeta.nombre : (rutaNorm.split("/").pop() ?? carpeta.nombre);
  return { nombreZip: `${base}.zip`, entradas };
};
