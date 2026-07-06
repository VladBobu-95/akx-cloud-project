import { Request, Response, NextFunction } from "express";
import {
  login,
  schemaLogin,
  actualizarPerfil,
  schemaActualizarPerfil,
  perfilConCapacidades,
} from "../services/auth.service";

// Los controladores ya no necesitan try/catch propio.
// Si algo falla, next(error) se lo pasa al errorHandler global de index.ts.

// POST /api/auth/login
export const ctrlLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaLogin.parse(req.body);
    const resultado = await login(datos);
    res.json(resultado);
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/perfil  (ruta protegida)
// Re-lee el usuario de BD (incluidas sus capacidades funcionales, que pueden
// haber cambiado tras el login) para que el frontend refresque qué mostrar
// —p. ej. ocultar el chat si el admin le ha quitado la capacidad "chat"—.
export const ctrlPerfil = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const usuario = await perfilConCapacidades(req.usuario!.id);
    res.json({ usuario });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/auth/perfil
export const ctrlActualizarPerfil = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaActualizarPerfil.parse(req.body);
    await actualizarPerfil(req.usuario!.id, datos);
    const usuario = await perfilConCapacidades(req.usuario!.id);
    res.json({ usuario });
  } catch (error) {
    next(error);
  }
};
