import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";

// Expresion regular que comprueba el formato estandar de un UUID v4:
// 8-4-4-4-12 caracteres hexadecimales separados por guiones
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Middleware: valida que req.params.id sea un UUID valido antes de ir a la BD.
// Sin esto, si alguien manda /api/archivos/esto-no-es-uuid, la query a Postgres
// fallaria con un error interno en vez de un 400 claro.
export const validarUUID = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const id = String(req.params.id ?? "");

  if (id && !UUID_REGEX.test(id)) {
    next(new AppError(400, "El ID proporcionado no tiene un formato valido"));
    return;
  }

  next();
};