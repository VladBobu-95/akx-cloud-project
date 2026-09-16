import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { AppDataSource } from "../config/database";
import { Empresa } from "../entities/Empresa";
import { Usuario } from "../entities/Usuario";
import { AppError } from "../utils/errors";

const clavesIguales = (recibida: string, esperada: string): boolean => {
  const a = createHash("sha256").update(recibida).digest();
  const b = createHash("sha256").update(esperada).digest();
  return timingSafeEqual(a, b);
};

const leerApiKey = (req: Request): string => {
  const raw = req.headers["x-api-key"];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return "";
};

// Autentica POST /api/n8n/* con X-Api-Key (no JWT). Si la key es válida, deja
// req.usuario como el dueño configurado en N8N_USER_EMAIL para reutilizar
// ctrlSubir y el auto-escaneo. Sin N8N_API_KEY en env, el endpoint está apagado.
export const verificarApiKeyN8n = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!env.N8N_API_KEY || !env.N8N_USER_EMAIL) {
      throw new AppError(503, "Integración n8n no configurada");
    }

    const recibida = leerApiKey(req);
    if (!recibida || !clavesIguales(recibida, env.N8N_API_KEY)) {
      throw new AppError(401, "API key inválida");
    }

    const usuario = await AppDataSource.getRepository(Usuario).findOne({
      where: { email: env.N8N_USER_EMAIL },
    });
    if (!usuario) {
      throw new AppError(503, "Usuario n8n no encontrado");
    }

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

    next();
  } catch (error) {
    next(error);
  }
};
