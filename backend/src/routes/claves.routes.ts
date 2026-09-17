import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { validarUUID } from "../middlewares/validarUUID.middleware";
import {
  ctrlListarClaves,
  ctrlCrearClave,
  ctrlRevocarClave,
} from "../controllers/claves.controller";

const router = Router();

// Cualquier usuario autenticado (admin o miembro) gestiona SUS claves.
router.use(verificarToken);

router.get("/", ctrlListarClaves);
router.post("/", ctrlCrearClave);
router.delete("/:id", validarUUID, ctrlRevocarClave);

export default router;
