import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

interface JwtPayload {
  sub: string;
  email: string;
  rol: string;
}

// Middleware: verifica el token JWT antes de dejar pasar la peticion.
// Si el token es valido, adjunta los datos del usuario a req.usuario.
// Si no, pasa el error al errorHandler global via next(error).
export const verificarToken = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
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
    };

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

// Middleware adicional: solo deja pasar a usuarios con rol "admin"
// Se usa despues de verificarToken
export const soloAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  // req.usuario existe porque soloAdmin siempre va despues de verificarToken
  if (req.usuario?.rol !== "admin") {
    next(new AppError(403, "Acceso denegado: se requiere rol admin"));
    return;
  }
  next(); // es admin: dejamos pasar
};