import { Request, Response, NextFunction } from "express";
import {
  registrar,
  login,
  schemaRegistro,
  schemaLogin,
  actualizarPerfil,
  schemaActualizarPerfil,
} from "../services/auth.service";

// Los controladores ya no necesitan try/catch propio.
// Si algo falla, next(error) se lo pasa al errorHandler global de index.ts.

// POST /api/auth/registro
export const ctrlRegistrar = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaRegistro.parse(req.body);
    const resultado = await registrar(datos);
    res.status(201).json(resultado);
  } catch (error) {
    next(error); // errorHandler global se encarga del resto
  }
};

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
export const ctrlPerfil = (req: Request, res: Response): void => {
  // No puede fallar: si llegamos aquí, verificarToken ya validó el token
  res.json({ usuario: req.usuario });
};

// PATCH /api/auth/perfil
export const ctrlActualizarPerfil = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaActualizarPerfil.parse(req.body);
    const usuario = await actualizarPerfil(req.usuario!.id, datos);
    res.json({ usuario });
  } catch (error) {
    next(error);
  }
};
