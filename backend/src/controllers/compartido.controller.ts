import { Request, Response, NextFunction } from "express";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ZipArchive } = require("archiver") as { ZipArchive: new (options?: { zlib?: { level?: number } }) => import("archiver").Archiver };
import {
  listarCarpetasAdmin,
  crearCarpetaCompartida,
  actualizarCarpetaCompartida,
  eliminarCarpetaCompartida,
  carpetasAccesibles,
  listarArchivosCompartidos,
  subirCompartido,
  descargarCompartido,
  eliminarCompartido,
  listarTodosCompartidos,
  listarSubcarpetasCompartidas,
  crearSubcarpetaCompartida,
  eliminarSubcarpetaCompartida,
  reubicarSubcarpetaCompartida,
  actualizarArchivoCompartido,
  copiarArchivoCompartido,
  prepararDescargaCarpetaCompartida,
  schemaCrearCarpetaCompartida,
  schemaActualizarCarpetaCompartida,
} from "../services/compartido.service";
import { encolarTarea, marcarIndexadoPendiente, P_OCR, P_TEXTO } from "../services/tareas.service";
import { AppError } from "../utils/errors";
import { validarContenidoArchivo } from "../utils/tiposArchivo";

const empresaDe = (req: Request): string => req.usuario!.empresaId!;

// ---- ADMIN: gestión de carpetas compartidas (soloAdmin) ----
export const ctrlListarAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listarCarpetasAdmin(empresaDe(req)));
  } catch (error) {
    next(error);
  }
};

export const ctrlCrear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaCrearCarpetaCompartida.parse(req.body);
    res.status(201).json(await crearCarpetaCompartida(empresaDe(req), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlActualizar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaActualizarCarpetaCompartida.parse(req.body);
    res.json(await actualizarCarpetaCompartida(empresaDe(req), String(req.params.id), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlEliminar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await eliminarCarpetaCompartida(empresaDe(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ---- MIEMBRO: uso de carpetas compartidas accesibles ----
export const ctrlAccesibles = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const carpetas = await carpetasAccesibles(req.usuario!.id);
    res.json(carpetas.map((c) => ({ id: c.id, nombre: c.nombre })));
  } catch (error) {
    next(error);
  }
};

export const ctrlListarArchivos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const carpeta = req.query.carpeta ? String(req.query.carpeta) : undefined;
    res.json(await listarArchivosCompartidos(req.usuario!.id, String(req.params.id), carpeta));
  } catch (error) {
    next(error);
  }
};

export const ctrlSubir = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new AppError(400, "No se ha proporcionado ningún archivo");
    // 2ª barrera: valida el contenido real (magic bytes), no solo el mimeType declarado.
    validarContenidoArchivo(req.file.buffer, req.file.mimetype);
    const carpeta = (req.body.carpeta as string) || "/";

    const { archivo, duplicado } = await subirCompartido(
      req.file,
      req.usuario!.id,
      String(req.params.id),
      carpeta,
    );

    if (duplicado) {
      res.status(200).json({ ...archivo, duplicado: true });
      return;
    }

    // Indexado RAG en segundo plano (la cola durable). El worker NO auto-escanea
    // facturas compartidas (ver tareas.service). Así el archivo es buscable por
    // todos los del rol, indexado una sola vez.
    await marcarIndexadoPendiente(archivo.id);
    await encolarTarea({
      tipo: "indexar",
      archivoId: archivo.id,
      usuarioId: req.usuario!.id,
      prioridad: /^image\//.test(archivo.mimeType) ? P_OCR : P_TEXTO,
    });

    res.status(201).json(archivo);
  } catch (error) {
    next(error);
  }
};

export const ctrlDescargar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { archivo, stream } = await descargarCompartido(String(req.params.archivoId), req.usuario!.id);
    res.setHeader("Content-Type", archivo.mimeType);
    res.setHeader("Content-Length", archivo.tamanoBytes);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`,
    );
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
};

export const ctrlEliminarArchivo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await eliminarCompartido(String(req.params.archivoId), req.usuario!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ---- Explorador completo (paridad con "Mis archivos") ----

// GET /:id/todos → todos los archivos de la carpeta compartida (para el árbol).
export const ctrlListarTodos = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listarTodosCompartidos(req.usuario!.id, String(req.params.id)));
  } catch (error) {
    next(error);
  }
};

// GET /:id/carpetas → subcarpetas explícitas persistidas.
export const ctrlListarSubcarpetas = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listarSubcarpetasCompartidas(req.usuario!.id, String(req.params.id)));
  } catch (error) {
    next(error);
  }
};

// POST /:id/carpetas { ruta }
export const ctrlCrearSubcarpeta = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ruta = String(req.body?.ruta ?? "");
    if (!ruta) throw new AppError(400, "Falta la ruta de la carpeta");
    const creada = await crearSubcarpetaCompartida(req.usuario!.id, String(req.params.id), ruta);
    res.status(201).json({ ruta: creada });
  } catch (error) {
    next(error);
  }
};

// PATCH /:id/carpetas { origen, destino }
export const ctrlReubicarSubcarpeta = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const origen = String(req.body?.origen ?? "");
    const destino = String(req.body?.destino ?? "");
    if (!origen || !destino) throw new AppError(400, "Faltan origen o destino");
    await reubicarSubcarpetaCompartida(req.usuario!.id, String(req.params.id), origen, destino);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /:id/carpetas?ruta=
export const ctrlEliminarSubcarpeta = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ruta = typeof req.query.ruta === "string" ? req.query.ruta : "";
    if (!ruta) throw new AppError(400, "Falta la ruta de la carpeta");
    await eliminarSubcarpetaCompartida(req.usuario!.id, String(req.params.id), ruta);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// PATCH /archivo/:archivoId { nombre?, carpeta? }
export const ctrlActualizarArchivo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { nombre, carpeta } = req.body ?? {};
    const datos: { nombre?: string; carpeta?: string } = {};
    if (nombre !== undefined) datos.nombre = String(nombre);
    if (carpeta !== undefined) datos.carpeta = String(carpeta);
    res.json(await actualizarArchivoCompartido(String(req.params.archivoId), req.usuario!.id, datos));
  } catch (error) {
    next(error);
  }
};

// POST /archivo/:archivoId/copiar { carpeta?, nombre? }
export const ctrlCopiarArchivo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { nombre, carpeta } = req.body ?? {};
    const datos: { nombre?: string; carpeta?: string } = {};
    if (nombre !== undefined) datos.nombre = String(nombre);
    if (carpeta !== undefined) datos.carpeta = String(carpeta);
    res.status(201).json(await copiarArchivoCompartido(String(req.params.archivoId), req.usuario!.id, datos));
  } catch (error) {
    next(error);
  }
};

// GET /:id/carpeta/descargar?ruta= → .zip de la subcarpeta (o de toda la carpeta).
export const ctrlDescargarCarpetaZip = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ruta = typeof req.query.ruta === "string" ? req.query.ruta : "/";
    const { nombreZip, entradas } = await prepararDescargaCarpetaCompartida(
      req.usuario!.id,
      String(req.params.id),
      ruta,
    );

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(nombreZip)}`,
    );

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", next);
    archive.pipe(res);

    for (const entrada of entradas) {
      archive.append(entrada.stream, { name: entrada.name });
    }
    if (entradas.length === 0) {
      archive.append("", { name: nombreZip.replace(/\.zip$/, "") + "/" });
    }
    await archive.finalize();
  } catch (error) {
    next(error);
  }
};
