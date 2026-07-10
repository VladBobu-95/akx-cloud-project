import { AppDataSource } from "../config/database";
import { Carpeta } from "../entities/Carpeta";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { AppError } from "../utils/errors";
import { copiarArchivo } from "./archivos.service";
import { enSerieFacturas } from "./facturas.service";

const repo = () => AppDataSource.getRepository(Carpeta);

// Ruta canónica: "/a/b" ("/" = raíz, sin barra final).
export const normalizarRuta = (ruta: string): string => {
  const limpia = (ruta ?? "").replace(/^\/+|\/+$/g, "");
  return limpia ? `/${limpia}` : "/";
};

// Lista las carpetas explícitas del usuario (rutas + fecha de creación).
export const listarCarpetas = async (
  usuarioId: string,
): Promise<{ ruta: string; creada: string }[]> => {
  const filas = await repo()
    .createQueryBuilder("c")
    .where("c.propietarioId = :usuarioId", { usuarioId })
    .orderBy("c.ruta", "ASC")
    .getMany();
  return filas.map((c) => ({ ruta: c.ruta, creada: c.creadaEn.toISOString() }));
};

// Crea una carpeta (idempotente: si ya existe, no hace nada). Devuelve la ruta.
export const crearCarpeta = async (usuarioId: string, ruta: string): Promise<string> => {
  const r = normalizarRuta(ruta);
  if (r === "/") throw new AppError(400, "No se puede crear la carpeta raíz");

  const existe = await repo().findOne({
    where: { ruta: r, propietario: { id: usuarioId } },
  });
  if (!existe) {
    try {
      await repo().save(
        repo().create({ ruta: r, propietario: { id: usuarioId } as Usuario }),
      );
    } catch (err: unknown) {
      // 23505 = unique_violation: otra petición concurrente ya creó esta misma
      // carpeta entre el findOne y el save. Es idempotente, así que lo ignoramos.
      const code =
        (err as { code?: string; driverError?: { code?: string } })?.code ??
        (err as { driverError?: { code?: string } })?.driverError?.code;
      if (code !== "23505") throw err;
    }
  }
  return r;
};

// Borra una carpeta y todas sus subcarpetas (registros de metadata).
export const eliminarCarpeta = async (usuarioId: string, ruta: string): Promise<void> => {
  const r = normalizarRuta(ruta);
  await repo()
    .createQueryBuilder()
    .delete()
    .from(Carpeta)
    .where("propietarioId = :usuarioId", { usuarioId })
    .andWhere("(ruta = :r OR ruta LIKE :prefijo)", { r, prefijo: `${r}/%` })
    .execute();
};

// Lista TODAS las carpetas del usuario: las explícitas (tabla) MÁS las que existen
// porque contienen archivos (derivadas de la ruta), incluyendo carpetas ancestro.
export const listarTodasCarpetas = async (usuarioId: string): Promise<{ ruta: string }[]> => {
  const explicitas = (await listarCarpetas(usuarioId)).map((c) => c.ruta);
  const filas = await AppDataSource.getRepository(Archivo)
    .createQueryBuilder("a")
    .select("DISTINCT a.carpeta", "carpeta")
    .where("a.propietarioId = :u", { u: usuarioId })
    .andWhere("a.carpetaCompartidaId IS NULL") // no derivar carpetas personales de copias compartidas
    .getRawMany<{ carpeta: string }>();

  const set = new Set<string>();
  const anadirConAncestros = (ruta: string) => {
    let r = normalizarRuta(ruta);
    while (r !== "/") {
      set.add(r);
      const i = r.lastIndexOf("/");
      r = i <= 0 ? "/" : r.slice(0, i);
    }
  };
  for (const e of explicitas) anadirConAncestros(e);
  for (const f of filas) anadirConAncestros(f.carpeta);

  return [...set].sort().map((ruta) => ({ ruta }));
};

// Comprueba si una carpeta existe: o está en la tabla de carpetas (explícita o
// alguna subcarpeta) o tiene al menos un archivo activo dentro del subárbol.
export const carpetaExiste = async (usuarioId: string, ruta: string): Promise<boolean> => {
  const r = normalizarRuta(ruta);
  if (r === "/") return true; // la raíz siempre existe
  const enMeta = await repo()
    .createQueryBuilder("c")
    .where("c.propietarioId = :u", { u: usuarioId })
    .andWhere("(c.ruta = :r OR c.ruta LIKE :p)", { r, p: `${r}/%` })
    .getCount();
  if (enMeta > 0) return true;
  const conArchivos = await AppDataSource.getRepository(Archivo)
    .createQueryBuilder("a")
    .where("a.propietarioId = :u", { u: usuarioId })
    .andWhere("a.carpetaCompartidaId IS NULL") // solo cuenta como carpeta personal el contenido personal
    .andWhere("a.eliminadoEn IS NULL")
    .andWhere("(a.carpeta = :r OR a.carpeta LIKE :p)", { r, p: `${r}/%` })
    .getCount();
  return conArchivos > 0;
};

// Vacía el CONTENIDO de una carpeta (envía sus archivos a la papelera) pero deja
// la carpeta. Borra la metadata de las subcarpetas. Devuelve cuántos archivos movió.
// Caso especial r === "/": solo borra los archivos sueltos literalmente en la raíz
// (no toca lo que hay dentro de subcarpetas, que no son parte de "la raíz").
// Serializada por usuario (`enSerieFacturas`, ver facturas.service.ts) para que
// las operaciones bulk sobre carpetas del mismo usuario no se solapen entre sí.
export const vaciarCarpeta = (usuarioId: string, ruta: string): Promise<{ borrados: number }> =>
  enSerieFacturas(usuarioId, async () => {
    const r = normalizarRuta(ruta);
    if (r !== "/" && !(await carpetaExiste(usuarioId, r))) {
      throw new AppError(404, `No existe ninguna carpeta "${r}".`);
    }
    const query = AppDataSource.getRepository(Archivo)
      .createQueryBuilder()
      .softDelete()
      .where("propietarioId = :u", { u: usuarioId })
      // Nunca tocar copias que viven en carpetas compartidas: aunque el archivo
      // conserve `propietario` (autor) y una `carpeta` que coincida con la ruta
      // personal, es contenido compartido y no debe caer en operaciones del
      // espacio personal (si no, borrar/mover la carpeta personal lo arrastraría).
      .andWhere("carpetaCompartidaId IS NULL");
    if (r === "/") {
      query.andWhere("carpeta = '/'");
    } else {
      query.andWhere("(carpeta = :r OR carpeta LIKE :p)", { r, p: `${r}/%` });
    }
    const res = await query.execute();
    if (r !== "/") {
      // Borra la metadata de las subcarpetas (su contenido ya no existe) pero conserva la carpeta.
      await repo()
        .createQueryBuilder()
        .delete()
        .from(Carpeta)
        .where("propietarioId = :u", { u: usuarioId })
        .andWhere("ruta LIKE :p", { p: `${r}/%` })
        .execute();
      await crearCarpeta(usuarioId, r); // mantener la carpeta (ahora vacía)
    }
    return { borrados: res.affected ?? 0 };
  });

// Borra una carpeta y TODO su contenido: envía a la papelera los archivos del
// subárbol (soft-delete) y elimina la metadata de las carpetas. Devuelve cuántos
// archivos se enviaron a la papelera.
export const eliminarCarpetaConContenido = (
  usuarioId: string,
  ruta: string,
): Promise<{ borrados: number }> =>
  enSerieFacturas(usuarioId, async () => {
    const r = normalizarRuta(ruta);
    if (r === "/") throw new AppError(400, "No se puede eliminar la raíz");
    if (!(await carpetaExiste(usuarioId, r))) {
      throw new AppError(404, `No existe ninguna carpeta "${r}".`);
    }
    const res = await AppDataSource.getRepository(Archivo)
      .createQueryBuilder()
      .softDelete()
      .where("propietarioId = :u", { u: usuarioId })
      .andWhere("carpetaCompartidaId IS NULL") // no arrastrar copias compartidas
      .andWhere("(carpeta = :r OR carpeta LIKE :p)", { r, p: `${r}/%` })
      .execute();
    await eliminarCarpeta(usuarioId, r);
    return { borrados: res.affected ?? 0 };
  });

// Borra TODO: envía a la papelera todos los archivos activos del usuario y
// elimina la metadata de todas sus carpetas. Los archivos quedan recuperables
// desde la papelera (soft-delete). Devuelve cuántos archivos y carpetas afectó.
export const vaciarTodo = (
  usuarioId: string,
): Promise<{ archivos: number; carpetas: number }> =>
  enSerieFacturas(usuarioId, async () => {
    const resArchivos = await AppDataSource.getRepository(Archivo)
      .createQueryBuilder()
      .softDelete()
      .where("propietarioId = :u", { u: usuarioId })
      .andWhere("carpetaCompartidaId IS NULL") // no vaciar copias compartidas
      .andWhere("eliminadoEn IS NULL")
      .execute();
    const resCarpetas = await repo()
      .createQueryBuilder()
      .delete()
      .from(Carpeta)
      .where("propietarioId = :u", { u: usuarioId })
      .execute();
    return {
      archivos: resArchivos.affected ?? 0,
      carpetas: resCarpetas.affected ?? 0,
    };
  });

// Borra TODAS las carpetas y su contenido, pero NO toca los archivos que ya
// estaban en la raíz (fuera de cualquier carpeta). Devuelve cuántos archivos
// fueron a la papelera y cuántas carpetas se eliminaron.
export const eliminarTodasCarpetas = (
  usuarioId: string,
): Promise<{ borrados: number; carpetas: number }> =>
  enSerieFacturas(usuarioId, async () => {
    const resArchivos = await AppDataSource.getRepository(Archivo)
      .createQueryBuilder()
      .softDelete()
      .where("propietarioId = :u", { u: usuarioId })
      .andWhere("carpetaCompartidaId IS NULL") // no arrastrar copias compartidas
      .andWhere("eliminadoEn IS NULL")
      .andWhere("carpeta <> '/'")
      .execute();
    const resCarpetas = await repo()
      .createQueryBuilder()
      .delete()
      .from(Carpeta)
      .where("propietarioId = :u", { u: usuarioId })
      .execute();
    return { borrados: resArchivos.affected ?? 0, carpetas: resCarpetas.affected ?? 0 };
  });

// Mueve/renombra una carpeta CON su contenido: re-prefija la carpeta de todos los
// archivos del subárbol y la metadata de carpetas. Devuelve cuántos archivos movió.
export const moverCarpetaConContenido = (
  usuarioId: string,
  origen: string,
  destino: string,
): Promise<{ movidos: number }> =>
  enSerieFacturas(usuarioId, async () => {
    const o = normalizarRuta(origen);
    const d = normalizarRuta(destino);
    if (d === o || d.startsWith(`${o}/`)) {
      throw new AppError(400, "No puedes mover una carpeta dentro de sí misma");
    }
    if (!(await carpetaExiste(usuarioId, o))) {
      throw new AppError(404, `No existe ninguna carpeta "${o}".`);
    }
    const archivosRepo = AppDataSource.getRepository(Archivo);
    const archivos = await archivosRepo
      .createQueryBuilder("a")
      .where("a.propietarioId = :u", { u: usuarioId })
      .andWhere("a.carpetaCompartidaId IS NULL") // no re-prefijar copias compartidas
      .andWhere("(a.carpeta = :o OR a.carpeta LIKE :p)", { o, p: `${o}/%` })
      .getMany();
    for (const a of archivos) {
      a.carpeta = d + a.carpeta.slice(o.length);
    }
    if (archivos.length) await archivosRepo.save(archivos);
    await reubicarCarpeta(usuarioId, o, d);
    // Asegura que la carpeta destino exista como metadata.
    await crearCarpeta(usuarioId, d);
    return { movidos: archivos.length };
  });

// Copia una carpeta CON su contenido al destino. Devuelve cuántos archivos copió.
export const copiarCarpetaConContenido = async (
  usuarioId: string,
  origen: string,
  destino: string,
): Promise<{ copiados: number }> => {
  const o = normalizarRuta(origen);
  const d = normalizarRuta(destino);
  if (d === o || d.startsWith(`${o}/`)) {
    throw new AppError(400, "No puedes copiar una carpeta dentro de sí misma");
  }
  if (!(await carpetaExiste(usuarioId, o))) {
    throw new AppError(404, `No existe ninguna carpeta "${o}".`);
  }
  const archivosRepo = AppDataSource.getRepository(Archivo);
  const archivos = await archivosRepo
    .createQueryBuilder("a")
    .where("a.propietarioId = :u", { u: usuarioId })
    .andWhere("a.carpetaCompartidaId IS NULL") // no copiar copias compartidas como personales
    .andWhere("(a.carpeta = :o OR a.carpeta LIKE :p)", { o, p: `${o}/%` })
    .getMany();
  for (const a of archivos) {
    const carpetaDestino = d + a.carpeta.slice(o.length);
    await copiarArchivo(a.id, usuarioId, { carpeta: carpetaDestino });
  }
  // Replica las carpetas (incluidas las vacías) bajo el nuevo prefijo.
  const metas = await repo()
    .createQueryBuilder("c")
    .where("c.propietarioId = :u", { u: usuarioId })
    .andWhere("(c.ruta = :o OR c.ruta LIKE :p)", { o, p: `${o}/%` })
    .getMany();
  for (const c of metas) {
    await crearCarpeta(usuarioId, d + c.ruta.slice(o.length));
  }
  await crearCarpeta(usuarioId, d);
  return { copiados: archivos.length };
};

// Re-prefija las rutas al mover/renombrar una carpeta (origen -> destino).
export const reubicarCarpeta = async (
  usuarioId: string,
  origen: string,
  destino: string,
): Promise<void> => {
  const o = normalizarRuta(origen);
  const d = normalizarRuta(destino);
  const filas = await repo()
    .createQueryBuilder("c")
    .where("c.propietarioId = :usuarioId", { usuarioId })
    .andWhere("(c.ruta = :o OR c.ruta LIKE :prefijo)", { o, prefijo: `${o}/%` })
    .getMany();
  for (const c of filas) {
    c.ruta = d + c.ruta.slice(o.length);
  }
  if (filas.length) await repo().save(filas);
};
