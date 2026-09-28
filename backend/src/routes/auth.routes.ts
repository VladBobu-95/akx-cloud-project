import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  ctrlLogin,
  ctrlPerfil,
  ctrlActualizarPerfil,
} from "../controllers/auth.controller";
import { verificarToken } from "../middlewares/auth.middleware";
import { env } from "../config/env";

const router = Router();

// Rate limiting SOLO en produccion. En desarrollo y test se desactiva para no
// bloquear los muchos intentos seguidos que se hacen al desarrollar/probar.
const soloEnProduccion = () => env.NODE_ENV !== "production";

// Rate limit del login contra fuerza bruta. Solo cuentan los intentos FALLIDOS
// (skipSuccessfulRequests): antes contaba todos por IP, y en una oficina donde
// toda la plantilla sale a internet por la misma IP pública, el 11º login
// correcto en 15 min ya quedaba bloqueado para todos.
//  - Por IP + email: máx. 10 fallos cada 15 min contra una misma cuenta.
//  - Por IP: máx. 50 fallos cada 15 min, contra quien prueba muchas cuentas
//    (credential stuffing), sin afectar a una oficina donde alguno se equivoca.
const limitadorLoginCuenta = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "")}|${String(req.body?.email ?? "").trim().toLowerCase()}`,
  message: { error: "Demasiados intentos. Espera 15 minutos." },
  standardHeaders: true, // incluye cabeceras RateLimit-* en la respuesta
  legacyHeaders: false,
  skip: soloEnProduccion,
});
const limitadorLoginIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos. Espera 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: soloEnProduccion,
});

// No hay auto-registro público: las cuentas las crea el superadmin (admins de
// empresa, vía /api/plataforma) o el admin (miembros, vía /api/equipo).

// Rutas publicas (no requieren token)
router.post("/login", limitadorLoginIp, limitadorLoginCuenta, ctrlLogin);

// Ruta protegida: el middleware verificarToken se ejecuta antes que ctrlPerfil

router.get("/perfil", verificarToken, ctrlPerfil);
router.patch("/perfil", verificarToken, ctrlActualizarPerfil);

export default router;
