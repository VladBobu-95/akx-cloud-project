import rateLimit from "express-rate-limit";
import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { tareasActivasDeUsuario } from "../services/tareas.service";

// Límites para los endpoints CAROS (chat, escanear, subir) que consumen GPU/
// Ollama o disco (#8). Antes solo /auth tenía rate-limit, así que un solo
// usuario podía martillear el chat o el escaneo y saturar la GPU.
//
// Se aplican DESPUÉS de verificarToken, así que se puede limitar POR USUARIO
// (no por IP), que es lo justo aquí. Solo activos en producción, igual que los
// de /auth, para no estorbar al desarrollar/probar.

const soloEnProduccion = () => env.NODE_ENV !== "production";

// Clave por usuario (siempre hay req.usuario tras verificarToken). Evitamos
// req.ip a propósito para no entrar en la validación IPv6 de la librería.
const porUsuario = (req: Request): string => req.usuario?.id ?? "sin-usuario";

const crearLimitador = (max: number, mensaje: string) =>
  rateLimit({
    windowMs: 60 * 1000, // ventana de 1 minuto
    max,
    message: { error: mensaje },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: porUsuario,
    skip: soloEnProduccion,
  });

// Valores generosos para el uso normal pero que cortan el abuso.
export const limitadorChat = crearLimitador(40, "Vas demasiado rápido con el chat. Espera un momento.");
export const limitadorEscaneo = crearLimitador(30, "Demasiados escaneos seguidos. Espera un momento.");
export const limitadorSubida = crearLimitador(120, "Demasiadas subidas seguidas. Espera un momento.");

// Cap de BACKLOG por usuario: a diferencia del rate-limit (por tiempo), mira el
// trabajo realmente pendiente/en proceso en la cola durable. Evita que un solo
// usuario encole miles de tareas y monopolice el worker (que procesa de una en
// una hacia la GPU). Umbral alto: no estorba subidas masivas normales.
export const limiteBacklogUsuario = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const activas = await tareasActivasDeUsuario(req.usuario!.id);
    if (activas >= env.MAX_BACKLOG_USUARIO) {
      throw new AppError(
        429,
        "Tienes demasiados archivos en cola de procesado. Espera a que avancen antes de subir/escanear más.",
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};
