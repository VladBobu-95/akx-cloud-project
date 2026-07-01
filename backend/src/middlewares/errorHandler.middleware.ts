import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { AppError } from "../utils/errors";

// Middleware global de errores de Express.
// Se ejecuta cuando cualquier middleware o ruta llama a next(error),
// o cuando ocurre un error no capturado en la cadena de middlewares.
// IMPORTANTE: debe tener exactamente 4 parámetros para que Express
// lo reconozca como error handler, aunque no uses "next".
export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void => {
  // Error de validación Zod
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Datos inválidos",
      detalles: error.issues.map((e) => ({
        campo: e.path.join("."),
        mensaje: e.message,
      })),
    });
    return;
  }

  // Errores de multer (subida): sobre todo el tamaño máximo. Sin esto, superar el
  // límite de 50 MB caía al 500 genérico ("Error interno") en vez de avisar de que
  // el archivo es demasiado grande.
  if (error instanceof MulterError) {
    const mensaje =
      error.code === "LIMIT_FILE_SIZE"
        ? "El archivo es demasiado grande (máximo 50 MB)."
        : `Error al subir el archivo: ${error.message}`;
    res.status(400).json({ error: mensaje });
    return;
  }

  // Error controlado de la aplicación
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  // Error inesperado: loguear en servidor, respuesta genérica al cliente
  console.error("[Error no controlado]", error);
  res.status(500).json({ error: "Error interno del servidor" });
};