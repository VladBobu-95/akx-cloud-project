import { Request, Response, NextFunction } from "express";
import {
  listarEmpresas,
  crearEmpresaConAdmin,
  actualizarEmpresa,
  eliminarEmpresa,
  schemaCrearEmpresa,
  schemaActualizarEmpresa,
} from "../services/plataforma.service";

// GET /api/plataforma/empresas
export const ctrlListarEmpresas = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json(await listarEmpresas());
  } catch (error) {
    next(error);
  }
};

// POST /api/plataforma/empresas  (crea empresa + su primer admin)
export const ctrlCrearEmpresa = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaCrearEmpresa.parse(req.body);
    const resultado = await crearEmpresaConAdmin(datos);
    res.status(201).json(resultado);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/plataforma/empresas/:id  (renombrar / suspender / reactivar)
export const ctrlActualizarEmpresa = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaActualizarEmpresa.parse(req.body);
    const empresa = await actualizarEmpresa(String(req.params.id), datos);
    res.json(empresa);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/plataforma/empresas/:id
export const ctrlEliminarEmpresa = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await eliminarEmpresa(String(req.params.id));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
