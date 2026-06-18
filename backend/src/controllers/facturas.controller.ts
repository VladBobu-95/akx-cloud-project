import { Request, Response, NextFunction } from "express";
import { escanearFactura } from "../services/facturas.service";
import { AppError } from "../utils/errors";

// POST /api/facturas/escanear  { archivoId, pista? }
export const ctrlEscanear = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const archivoId = String(req.body.archivoId ?? "");
    if (!archivoId) throw new AppError(400, "Falta el archivoId");
    const pista = typeof req.body.pista === "string" ? req.body.pista : undefined;
    const resultado = await escanearFactura(req.usuario!.id, archivoId, { pista });
    res.json(resultado);
  } catch (error) {
    next(error);
  }
};
