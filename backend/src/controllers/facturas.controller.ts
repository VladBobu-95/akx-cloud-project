import { Request, Response, NextFunction } from "express";
import { encolarEscaneoManual } from "../services/facturas.service";
import { AppError } from "../utils/errors";

// POST /api/facturas/escanear  { archivoId, pista? }
// Dispara el escaneo en segundo plano y responde al instante (202): el OCR/IA
// puede tardar minutos. El resultado se ve en la columna "Estado" del explorador.
export const ctrlEscanear = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const archivoId = String(req.body.archivoId ?? "");
    if (!archivoId) throw new AppError(400, "Falta el archivoId");
    const pista = typeof req.body.pista === "string" ? req.body.pista : undefined;
    await encolarEscaneoManual(req.usuario!.id, archivoId, pista);
    res.status(202).json({ estado: "pendiente" });
  } catch (error) {
    next(error);
  }
};
