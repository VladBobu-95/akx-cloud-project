import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { AppDataSource } from "../config/database";
import { Empresa } from "../entities/Empresa";
import { Usuario } from "../entities/Usuario";
import { AppError } from "../utils/errors";
import { clavesIguales, usuarioPorClaveBd } from "../services/claves.service";

const leerApiKey = (req: Request): string => {
  const raw = req.headers["x-api-key"];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return "";
};

const aplicarUsuario = async (req: Request, usuario: Usuario): Promise<void> => {
  req.usuario = {
    id: usuario.id,
    email: usuario.email,
    rol: usuario.rol,
    empresaId: usuario.empresaId ?? null,
  };

  if (req.usuario.rol !== "superadmin" && req.usuario.empresaId) {
    const empresa = await AppDataSource.getRepository(Empresa).findOne({
      where: { id: req.usuario.empresaId },
      select: { id: true, estado: true },
    });
    if (!empresa || empresa.estado === "suspendida") {
      throw new AppError(403, "Tu empresa está suspendida o no existe.");
    }
  }
};

// Autentica POST /api/n8n/* con X-Api-Key (no JWT).
// 1) Si coincide N8N_API_KEY del .env (pruebas), usa N8N_USER_EMAIL.
// 2) Si no, busca una clave activa en BD (la que genera cada usuario en Perfil).
export const verificarApiKeyN8n = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const recibida = leerApiKey(req);
    if (!recibida) {
      throw new AppError(401, "API key inválida");
    }

    if (env.N8N_API_KEY && clavesIguales(recibida, env.N8N_API_KEY)) {
      if (!env.N8N_USER_EMAIL) {
        throw new AppError(503, "Integración n8n no configurada");
      }
      const usuario = await AppDataSource.getRepository(Usuario).findOne({
        where: { email: env.N8N_USER_EMAIL },
      });
      if (!usuario) {
        throw new AppError(503, "Usuario n8n no encontrado");
      }
      await aplicarUsuario(req, usuario);
      next();
      return;
    }

    const deBd = await usuarioPorClaveBd(recibida);
    if (!deBd) {
      throw new AppError(401, "API key inválida");
    }
    await aplicarUsuario(req, deBd);
    next();
  } catch (error) {
    next(error);
  }
};
