import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AppDataSource } from "../config/database";
import { Empresa } from "../entities/Empresa";

interface JwtPayload {
  sub: string;
  email: string;
  rol: string;
  empresaId?: string | null;
}

// Middleware: verifica el token JWT antes de dejar pasar la peticion.
// Si el token es valido, adjunta los datos del usuario a req.usuario.
// Si no, pasa el error al errorHandler global via next(error).
export const verificarToken = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(401, "Token no proporcionado");
    }

    const token = authHeader.split(" ")[1];

    // jwt.verify lanza excepcion si el token esta caducado o es invalido
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // Adjuntamos los datos del usuario al request para los controladores
    req.usuario = {
      id: payload.sub,
      email: payload.email,
      rol: payload.rol,
      empresaId: payload.empresaId ?? null,
    };

    // Empresa suspendida: se bloquea en CADA petición, no solo en el login. Los
    // tokens viven 7 días, así que un usuario con sesión abierta seguiría entrando
    // tras suspender su empresa si no se comprueba aquí. El superadmin no tiene
    // empresa, así que se salta este chequeo.
    if (req.usuario.rol !== "superadmin" && req.usuario.empresaId) {
      const empresa = await AppDataSource.getRepository(Empresa).findOne({
        where: { id: req.usuario.empresaId },
        select: { id: true, estado: true },
      });
      if (!empresa || empresa.estado === "suspendida") {
        throw new AppError(403, "Tu empresa está suspendida o no existe.");
      }
    }

    next();
  } catch (error) {
    // Si es un error de JWT (token invalido/caducado), lo convertimos a AppError
    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError(401, "Token invalido o caducado"));
      return;
    }
    next(error);
  }
};

// Middleware adicional: solo deja pasar a usuarios con rol "admin" (admin de su
// empresa). Se usa despues de verificarToken.
export const soloAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // req.usuario existe porque soloAdmin siempre va despues de verificarToken
  if (req.usuario?.rol !== "admin") {
    next(new AppError(403, "Acceso denegado: se requiere rol admin"));
    return;
  }
  next(); // es admin: dejamos pasar
};

// Middleware adicional: solo el superadmin de la plataforma (gestión de empresas).
export const soloSuperadmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (req.usuario?.rol !== "superadmin") {
    next(new AppError(403, "Acceso denegado: se requiere superadmin"));
    return;
  }
  next();
};
