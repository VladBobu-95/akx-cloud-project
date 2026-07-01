import { randomUUID } from "crypto";
import { Readable } from "stream";
import { z } from "zod";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../config/database";
import { CarpetaCompartida } from "../entities/CarpetaCompartida";
import { CarpetaCompartidaCarpeta } from "../entities/CarpetaCompartidaCarpeta";
import { Rol } from "../entities/Rol";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { EventoCompartido, AccionCompartida } from "../entities/EventoCompartido";
import { minioClient } from "../config/minio";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { calcularHashSha256 } from "./archivos.service";
import { crearCarpeta } from "./carpetas.service";
import { esArchivoFactura, marcarPendiente } from "./facturas.service";
import { encolarTarea, P_ALTA, P_IMG_SCAN } from "./tareas.service";

// Carpetas compartidas por rol. El admin las crea y decide qué roles acceden; los
// miembros con esos roles ven/usan los archivos (almacenamiento ÚNICO: lo que
// sube uno lo ven todos los del rol). Acceso por empresa+roles, NO por propietario.

const ccRepo = () => AppDataSource.getRepository(CarpetaCompartida);
const ccCarpetaRepo = () => AppDataSource.getRepository(CarpetaCompartidaCarpeta);
const rolRepo = () => AppDataSource.getRepository(Rol);
const usuarioRepo = () => AppDataSource.getRepository(Usuario);
const archivoRepo = () => AppDataSource.getRepository(Archivo);
const eventoRepo = () => AppDataSource.getRepository(EventoCompartido);

// Registra una acción en el historial de una carpeta compartida. Guarda el nombre
// del usuario como snapshot (para que el evento se lea aunque luego se borre el
// usuario). NUNCA lanza: un fallo del log no debe tumbar la operación principal.
export const registrarEvento = async (
  carpetaCompartidaId: string,
  usuarioId: string,
  accion: AccionCompartida,
  extra: { objeto?: string; ruta?: string; detalle?: string } = {},
): Promise<void> => {
  try {
    const usuario = await usuarioRepo().findOne({
      where: { id: usuarioId },
      select: { id: true, nombre: true },
    });
    await eventoRepo().insert({
      carpetaCompartidaId,
      usuarioId,
      usuarioNombre: usuario?.nombre ?? "—",
      accion,
      objeto: extra.objeto ?? null,
      ruta: extra.ruta ?? null,
      detalle: extra.detalle ?? null,
    });
  } catch (err) {
    console.error("[eventos] no se pudo registrar el evento:", err);
  }
};

// Historial de una carpeta compartida (para el admin de la empresa dueña),
// paginado y más reciente primero.
export const listarEventos = async (
  empresaId: string,
  carpetaCompartidaId: string,
  pagina = 1,
  limite = 20,
): Promise<{ eventos: EventoCompartido[]; total: number; paginas: number }> => {
  const carpeta = await ccRepo().findOneBy({ id: carpetaCompartidaId, empresaId });
  if (!carpeta) throw new AppError(404, "Carpeta compartida no encontrada");
  const [eventos, total] = await eventoRepo().findAndCount({
    where: { carpetaCompartidaId },
    order: { creadoEn: "DESC" },
    skip: (pagina - 1) * limite,
    take: limite,
  });
  return { eventos, total, paginas: Math.max(1, Math.ceil(total / limite)) };
};

// Retención: borra eventos con más de `dias` días de antigüedad. 0 = sin límite
// (no se purga). Lo llama el mantenimiento periódico (reconciliacion.service).
export const purgarEventosAntiguos = async (
  dias: number = env.RETENCION_LOGS_DIAS,
): Promise<{ purgados: number }> => {
  if (dias <= 0) return { purgados: 0 };
  const corte = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const res = await eventoRepo()
    .createQueryBuilder()
    .delete()
    .from(EventoCompartido)
    .where("creadoEn < :corte", { corte })
    .execute();
  return { purgados: res.affected ?? 0 };
};

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

// Resumen por carpeta compartida para el listado de "Compartido": tamaño total
// (suma de bytes de sus archivos) y última actualización (subida más reciente).
// Una sola query agregada para todas las carpetas dadas.
export const resumenCompartidas = async (
  ids: string[],
): Promise<Map<string, { tamano: number; actualizado: string | null }>> => {
  const resumen = new Map<string, { tamano: number; actualizado: string | null }>();
  if (ids.length === 0) return resumen;
  const filas: Array<{ id: string; tamano: string; actualizado: Date | null }> = await archivoRepo()
    .createQueryBuilder("a")
    .select("a.carpetaCompartidaId", "id")
    .addSelect("COALESCE(SUM(a.tamanoBytes), 0)", "tamano")
    .addSelect("MAX(a.actualizadoEn)", "actualizado")
    .where("a.carpetaCompartidaId IN (:...ids)", { ids })
    .groupBy("a.carpetaCompartidaId")
    .getRawMany();
  for (const f of filas) {
    resumen.set(f.id, {
      tamano: Number(f.tamano),
      actualizado: f.actualizado ? new Date(f.actualizado).toISOString() : null,
    });
  }
  return resumen;
};

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
    await registrarEvento(carpetaCompartidaId, usuarioId, "subir", {
      objeto: guardado.nombre,
      ruta: carpetaFinal,
    });
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
  await registrarEvento(archivo.carpetaCompartidaId!, usuarioId, "descargar", {
    objeto: archivo.nombre,
    ruta: archivo.carpeta,
  });
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
  await registrarEvento(archivo.carpetaCompartidaId!, usuarioId, "eliminar", {
    objeto: archivo.nombre,
    ruta: archivo.carpeta,
  });
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
  // false cuando lo llama un movimiento de carpeta (para no registrar un
  // "crear_carpeta" espurio: ese caso ya se registra como "mover_carpeta").
  registrar = true,
): Promise<string> => {
  await verificarAcceso(usuarioId, carpetaCompartidaId);
  const r = normalizarCarpeta(ruta);
  if (r === "/") throw new AppError(400, "No se puede crear la carpeta raíz");
  const existe = await ccCarpetaRepo().findOneBy({ carpetaCompartidaId, ruta: r });
  let creada = false;
  if (!existe) {
    try {
      await ccCarpetaRepo().save(ccCarpetaRepo().create({ carpetaCompartidaId, ruta: r }));
      creada = true;
    } catch (err: unknown) {
      // 23505 = unique_violation por creación concurrente; idempotente, se ignora.
      const code =
        (err as { code?: string; driverError?: { code?: string } })?.code ??
        (err as { driverError?: { code?: string } })?.driverError?.code;
      if (code !== "23505") throw err;
    }
  }
  if (creada && registrar) {
    await registrarEvento(carpetaCompartidaId, usuarioId, "crear_carpeta", {
      objeto: r.split("/").pop() ?? r,
      ruta: r,
    });
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
  await registrarEvento(carpetaCompartidaId, usuarioId, "borrar_carpeta", {
    objeto: r.split("/").pop() ?? r,
    ruta: r,
  });
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
  // registrar=false: este movimiento se registra como "mover_carpeta", no como
  // un "crear_carpeta" del destino.
  await crearSubcarpetaCompartida(usuarioId, carpetaCompartidaId, d, false);
  await registrarEvento(carpetaCompartidaId, usuarioId, "mover_carpeta", {
    objeto: d.split("/").pop() ?? d,
    ruta: d,
    detalle: `${o} → ${d}`,
  });
};

// Renombra/mueve un archivo compartido DENTRO de su misma carpeta compartida.
export const actualizarArchivoCompartido = async (
  archivoId: string,
  usuarioId: string,
  datos: { nombre?: string; carpeta?: string },
): Promise<Archivo> => {
  const archivo = await cargarCompartidoConAcceso(archivoId, usuarioId);
  const nombreAntes = archivo.nombre;
  const carpetaAntes = archivo.carpeta;
  if (datos.nombre !== undefined) archivo.nombre = datos.nombre;
  if (datos.carpeta !== undefined) archivo.carpeta = normalizarCarpeta(datos.carpeta);
  const guardado = await archivoRepo().save(archivo);
  const ccId = archivo.carpetaCompartidaId!;
  if (datos.nombre !== undefined && archivo.nombre !== nombreAntes) {
    await registrarEvento(ccId, usuarioId, "renombrar", {
      objeto: archivo.nombre,
      ruta: archivo.carpeta,
      detalle: `${nombreAntes} → ${archivo.nombre}`,
    });
  }
  if (datos.carpeta !== undefined && archivo.carpeta !== carpetaAntes) {
    await registrarEvento(ccId, usuarioId, "mover", {
      objeto: archivo.nombre,
      ruta: archivo.carpeta,
      detalle: `${carpetaAntes} → ${archivo.carpeta}`,
    });
  }
  return guardado;
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
    await registrarEvento(carpetaCompartidaId, usuarioId, "copiar", {
      objeto: guardado.nombre,
      ruta: carpetaFinal,
      detalle: `desde ${original.nombre}`,
    });
    return guardado;
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, nuevaClave).catch(() => {});
    throw err;
  }
};

// Copia un archivo compartido al espacio PERSONAL de quien la pide (fuera de la
// carpeta compartida). El original PERMANECE en compartido. Se comporta como una
// subida propia: nombre EXACTO (sin "(copia)"), dedup por hash con lo que ya tienes
// en personal, y auto-escaneo de factura si procede (la analítica de facturas es
// personal, así que ahora sí se atribuye a este usuario). Reutiliza el binario y los
// fragmentos RAG ya calculados del compartido: no re-OCR ni re-embeddings.
export const copiarCompartidoAPersonal = async (
  archivoId: string,
  usuarioId: string,
  carpetaDestino?: string,
): Promise<{ archivo: Archivo; duplicado: boolean }> => {
  const original = await cargarCompartidoConAcceso(archivoId, usuarioId);

  // Dedup por hash contra tus archivos PERSONALES vivos. El filtro
  // carpetaCompartidaId IS NULL es imprescindible: sin él, si quien copia es el
  // mismo que subió el compartido, el mismo hash + propietario casaría con el
  // propio archivo compartido y "reutilizaría" ese en vez de crear la copia personal.
  if (original.hashSha256) {
    const yaExiste = await archivoRepo().findOne({
      where: {
        propietario: { id: usuarioId },
        hashSha256: original.hashSha256,
        eliminadoEn: IsNull(),
        carpetaCompartidaId: IsNull(),
      },
    });
    if (yaExiste) return { archivo: yaExiste, duplicado: true };
  }

  // Carpeta y clave con el formato PERSONAL (${usuarioId}/...), no el de compartido.
  const carpetaFinal = normalizarCarpeta(carpetaDestino ?? "/");
  const carpetaLimpia = carpetaFinal === "/" ? "raiz" : carpetaFinal.slice(1);
  const nuevaClave = `${usuarioId}/${carpetaLimpia}/${randomUUID()}`;

  await minioClient.copyObject(
    env.MINIO_BUCKET,
    nuevaClave,
    `/${env.MINIO_BUCKET}/${original.claveMinio}`,
  );

  const copia = archivoRepo().create({
    nombre: original.nombre, // nombre EXACTO, sin sufijo "(copia)"
    carpeta: carpetaFinal,
    mimeType: original.mimeType,
    tamanoBytes: original.tamanoBytes,
    claveMinio: nuevaClave,
    hashSha256: original.hashSha256,
    textoExtraido: original.textoExtraido,
    propietario: { id: usuarioId } as Usuario,
    carpetaCompartidaId: null, // pasa a ser un archivo personal
    estadoIndexado: "indexado", // reutilizamos texto + fragmentos ya calculados
    indexadoEn: new Date(),
  });

  let guardado: Archivo;
  try {
    guardado = await archivoRepo().save(copia);
  } catch (err) {
    await minioClient.removeObject(env.MINIO_BUCKET, nuevaClave).catch(() => {});
    throw err;
  }

  // Persistimos la carpeta personal destino como metadata (igual que subirArchivo),
  // para que exista aunque un futuro movimiento la deje vacía.
  if (carpetaFinal !== "/") await crearCarpeta(usuarioId, carpetaFinal).catch(() => {});

  // Copiamos los fragmentos RAG como PERSONALES: nuevo propietario y sin carpeta
  // compartida, para que la copia sea buscable en el RAG personal sin re-embeddings.
  try {
    await AppDataSource.query(
      `INSERT INTO "fragmentos" ("archivoId", "propietarioId", "carpetaCompartidaId", "indice", "texto", "embedding")
       SELECT $1, $2, NULL, "indice", "texto", "embedding"
       FROM "fragmentos" WHERE "archivoId" = $3`,
      [guardado.id, usuarioId, original.id],
    );
  } catch (errFrag) {
    console.error(`Error copiando fragmentos RAG de "${original.nombre}":`, errFrag);
  }

  // Auto-escaneo "como si fuera mía": si es candidata a factura, encolamos la tarea
  // durable de autoescaneo. El worker deja el estado final en la columna "Estado".
  if (esArchivoFactura(guardado)) {
    await marcarPendiente(guardado);
    await encolarTarea({
      tipo: "autoescanear",
      archivoId: guardado.id,
      usuarioId,
      prioridad: /^image\//.test(guardado.mimeType) ? P_IMG_SCAN : P_ALTA,
    });
  }

  await registrarEvento(original.carpetaCompartidaId!, usuarioId, "copia_personal", {
    objeto: original.nombre,
    ruta: original.carpeta,
    detalle: carpetaFinal === "/" ? "a Mis archivos" : `a Mis archivos ${carpetaFinal}`,
  });

  return { archivo: guardado, duplicado: false };
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
