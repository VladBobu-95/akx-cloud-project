import { Request, Response, NextFunction } from "express";
import {
  crearClave,
  listarClaves,
  revocarClave,
  schemaCrearClave,
} from "../services/claves.service";

export const ctrlListarClaves = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json(await listarClaves(req.usuario!.id));
  } catch (error) {
    next(error);
  }
};

export const ctrlCrearClave = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaCrearClave.parse(req.body ?? {});
    const creada = await crearClave(req.usuario!.id, req.usuario!.empresaId, datos.nombre);
    res.status(201).json(creada);
  } catch (error) {
    next(error);
  }
};

export const ctrlRevocarClave = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await revocarClave(req.usuario!.id, String(req.params.id));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
