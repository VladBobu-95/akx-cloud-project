import { Request, Response, NextFunction } from "express";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ZipArchive } = require("archiver") as { ZipArchive: new (options?: { zlib?: { level?: number } }) => import("archiver").Archiver };
import {
  subirArchivo,
  listarArchivos,
  descargarArchivo,
  eliminarArchivo,
  obtenerArchivo,
  listarPapelera,
  restaurarArchivo,
  borrarPermanente,
  vaciarPapelera,
  copiarArchivo,
  schemaCopiarArchivo,
  prepararDescargaCarpeta,
  actualizarArchivo,
  schemaActualizarArchivo,
} from "../services/archivos.service";
import {
  listarCarpetas,
  crearCarpeta,
  eliminarCarpetaConContenido,
  reubicarCarpeta,
} from "../services/carpetas.service";
import { indexarArchivo, buscarSemantica } from "../services/rag.service";
import { autoEscanearArchivo } from "../services/facturas.service";
import { AppError } from "../utils/errors";

// GET /api/archivos/carpetas
export const ctrlListarCarpetas = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json(await listarCarpetas(req.usuario!.id));
  } catch (error) {
    next(error);
  }
};

// POST /api/archivos/carpetas  { ruta }
export const ctrlCrearCarpeta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ruta = await crearCarpeta(req.usuario!.id, String(req.body.ruta ?? ""));
    res.status(201).json({ ruta });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/archivos/carpetas  { origen, destino }  (mover / renombrar)
export const ctrlReubicarCarpeta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await reubicarCarpeta(req.usuario!.id, String(req.body.origen), String(req.body.destino));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/archivos/carpetas?ruta=/x
// Borra la carpeta Y manda su contenido a la papelera (de forma atómica en el
// servidor: busca todos los archivos del subárbol en la BD, no depende del cliente).
export const ctrlEliminarCarpeta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { borrados } = await eliminarCarpetaConContenido(
      req.usuario!.id,
      String(req.query.ruta ?? ""),
    );
    res.json({ borrados });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/archivos/:id  (renombrar / mover)
export const ctrlActualizar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaActualizarArchivo.parse(req.body);
    const archivo = await actualizarArchivo(
      String(req.params.id),
      req.usuario!.id,
      datos,
    );
    res.json(archivo);
  } catch (error) {
    next(error);
  }
};

// POST /api/archivos/subir
export const ctrlSubir = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.file) {
      throw new AppError(400, "No se ha proporcionado ningún archivo");
    }
    const carpeta = (req.body.carpeta as string) || "/";
    const archivo = await subirArchivo(req.file, carpeta, req.usuario!.id);
    res.status(201).json(archivo);

    // Indexado para búsqueda semántica (RAG) EN SEGUNDO PLANO: no esperamos a
    // que terminen los embeddings para responder (en CPU pueden tardar). Si falla,
    // solo se loguea: el archivo ya está subido y disponible igualmente.
    const buffer = req.file.buffer;
    const usuarioId = req.usuario!.id;
    void indexarArchivo(archivo, buffer, usuarioId).catch((err) =>
      console.error(`Error indexando "${archivo.nombre}":`, err),
    );

    // Auto-escaneo de factura EN SEGUNDO PLANO: si el archivo es PDF/imagen y parece
    // una factura, se extrae y guarda para que la analítica funcione sin pasos manuales.
    void autoEscanearArchivo(usuarioId, archivo).catch((err) =>
      console.error(`Error auto-escaneando "${archivo.nombre}":`, err),
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos/buscar?q=...  (búsqueda semántica sobre el contenido)
export const ctrlBuscarSemantica = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q.trim()) {
      res.json([]);
      return;
    }
    const resultados = await buscarSemantica(req.usuario!.id, q);
    res.json(resultados);
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos
export const ctrlListar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const carpeta =
      typeof req.query.carpeta === "string" ? req.query.carpeta : undefined;

    // Leemos pagina y limite del query string, con valores por defecto
    // ?pagina=2&limite=10  →  pagina=2, limite=10
    const pagina = Number(req.query.pagina) || 1;
    const limite = Math.min(Number(req.query.limite) || 20, 100); // máximo 100 por página

    const resultado = await listarArchivos(
      req.usuario!.id,
      carpeta,
      pagina,
      limite,
    );

    // Devolvemos los archivos + info de paginación en las cabeceras
    res.set("X-Total-Count", String(resultado.total));
    res.set("X-Total-Pages", String(resultado.paginas));
    res.set("X-Current-Page", String(pagina));
    res.json(resultado.archivos);
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos/:id
export const ctrlObtener = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const archivo = await obtenerArchivo(
      String(req.params.id),
      req.usuario!.id,
    );
    res.json(archivo);
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos/:id/descargar
export const ctrlDescargar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { archivo, stream } = await descargarArchivo(
      String(req.params.id),
      req.usuario!.id,
    );
    res.setHeader("Content-Type", archivo.mimeType);
    res.setHeader("Content-Length", archivo.tamanoBytes);
    // filename* (RFC 5987) para soportar nombres con acentos/UTF-8
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

// DELETE /api/archivos/:id
export const ctrlEliminar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await eliminarArchivo(String(req.params.id), req.usuario!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// PATCH /api/archivos/:id/restaurar
export const ctrlRestaurar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await restaurarArchivo(String(req.params.id), req.usuario!.id);
    res.json({ mensaje: "Archivo restaurado correctamente" });
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos/papelera
export const ctrlPapelera = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const archivos = await listarPapelera(req.usuario!.id);
    res.json(archivos);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/archivos/:id/permanente
export const ctrlBorrarPermanente = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await borrarPermanente(String(req.params.id), req.usuario!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// GET /api/archivos/carpeta/descargar?ruta=/facturas
export const ctrlDescargarCarpeta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ruta = typeof req.query.ruta === "string" ? req.query.ruta : "/";
    const { nombreZip, entradas } = await prepararDescargaCarpeta(
      req.usuario!.id,
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

// POST /api/archivos/:id/copiar
export const ctrlCopiar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaCopiarArchivo.parse(req.body);
    const archivo = await copiarArchivo(
      String(req.params.id),
      req.usuario!.id,
      datos,
    );
    res.status(201).json(archivo);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/archivos/papelera  (vaciar papelera)
export const ctrlVaciarPapelera = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { borrados } = await vaciarPapelera(req.usuario!.id);
    res.json({ mensaje: "Papelera vaciada", borrados });
  } catch (error) {
    next(error);
  }
};
