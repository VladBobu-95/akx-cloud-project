import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  ctrlRegistrar,
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

// Rate limiter especifico para login: maximo 10 intentos cada 15 minutos por IP.
// Evita ataques de fuerza bruta donde alguien prueba miles de passwords.
const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // ventana de 15 minutos
  max: 10, // maximo 10 intentos en esa ventana
  message: { error: "Demasiados intentos. Espera 15 minutos." },
  standardHeaders: true, // incluye cabeceras RateLimit-* en la respuesta
  legacyHeaders: false,
  skip: soloEnProduccion,
});

// Rate limiter para registro: maximo 5 cuentas nuevas por hora por IP.
// Evita que alguien cree cientos de cuentas automaticamente.
const limitadorRegistro = rateLimit({
  windowMs: 60 * 60 * 1000, // ventana de 1 hora
  max: 5,
  message: { error: "Demasiados registros desde esta IP. Espera 1 hora." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: soloEnProduccion,
});

// Rutas publicas (no requieren token)
router.post("/registro", limitadorRegistro, ctrlRegistrar);
router.post("/login", limitadorLogin, ctrlLogin);

// Ruta protegida: el middleware verificarToken se ejecuta antes que ctrlPerfil

router.get("/perfil", verificarToken, ctrlPerfil);
router.patch("/perfil", verificarToken, ctrlActualizarPerfil);

export default router;
