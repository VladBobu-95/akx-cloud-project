import { Request, Response, NextFunction } from "express";
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
  schemaCrearCarpetaCompartida,
  schemaActualizarCarpetaCompartida,
} from "../services/compartido.service";
import { encolarTarea, marcarIndexadoPendiente, P_OCR, P_TEXTO } from "../services/tareas.service";
import { AppError } from "../utils/errors";

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
