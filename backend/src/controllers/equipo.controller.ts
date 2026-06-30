import { Request, Response, NextFunction } from "express";
import {
  listarMiembros,
  crearMiembro,
  actualizarMiembro,
  eliminarMiembro,
  archivosDeMiembro,
  listarRoles,
  crearRol,
  actualizarRol,
  eliminarRol,
  schemaCrearMiembro,
  schemaActualizarMiembro,
  schemaCrearRol,
  schemaActualizarRol,
} from "../services/equipo.service";
import { CAPACIDADES } from "../config/capacidades";

// La empresa del admin sale del token (soloAdmin garantiza que existe).
const empresaDe = (req: Request): string => req.usuario!.empresaId!;

// ---- Vocabulario de capacidades (para pintar los toggles en el front) ----
export const ctrlCapacidades = (_req: Request, res: Response): void => {
  res.json(CAPACIDADES);
};

// ---- Miembros ----
export const ctrlListarMiembros = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listarMiembros(empresaDe(req)));
  } catch (error) {
    next(error);
  }
};

export const ctrlCrearMiembro = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaCrearMiembro.parse(req.body);
    res.status(201).json(await crearMiembro(empresaDe(req), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlActualizarMiembro = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaActualizarMiembro.parse(req.body);
    res.json(await actualizarMiembro(empresaDe(req), String(req.params.id), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlEliminarMiembro = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await eliminarMiembro(empresaDe(req), String(req.params.id), req.usuario!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const ctrlArchivosDeMiembro = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const pagina = Number(req.query.pagina) || 1;
    const limite = Math.min(Number(req.query.limite) || 20, 100);
    const carpeta = req.query.carpeta ? String(req.query.carpeta) : undefined;
    const resultado = await archivosDeMiembro(empresaDe(req), String(req.params.id), carpeta, pagina, limite);
    res.json(resultado);
  } catch (error) {
    next(error);
  }
};

// ---- Roles ----
export const ctrlListarRoles = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await listarRoles(empresaDe(req)));
  } catch (error) {
    next(error);
  }
};

export const ctrlCrearRol = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaCrearRol.parse(req.body);
    res.status(201).json(await crearRol(empresaDe(req), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlActualizarRol = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const datos = schemaActualizarRol.parse(req.body);
    res.json(await actualizarRol(empresaDe(req), String(req.params.id), datos));
  } catch (error) {
    next(error);
  }
};

export const ctrlEliminarRol = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await eliminarRol(empresaDe(req), String(req.params.id));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
