import { Router } from "express";
import {
  ctrlCapacidades,
  ctrlListarMiembros,
  ctrlCrearMiembro,
  ctrlActualizarMiembro,
  ctrlEliminarMiembro,
  ctrlArchivosDeMiembro,
  ctrlListarRoles,
  ctrlCrearRol,
  ctrlActualizarRol,
  ctrlEliminarRol,
} from "../controllers/equipo.controller";
import { verificarToken, soloAdmin } from "../middlewares/auth.middleware";

const router = Router();

// Todo el equipo es exclusivo del admin de la empresa.
router.use(verificarToken, soloAdmin);

router.get("/capacidades", ctrlCapacidades);

// Miembros
router.get("/usuarios", ctrlListarMiembros);
router.post("/usuarios", ctrlCrearMiembro);
router.patch("/usuarios/:id", ctrlActualizarMiembro);
router.delete("/usuarios/:id", ctrlEliminarMiembro);
router.get("/usuarios/:id/archivos", ctrlArchivosDeMiembro);

// Roles
router.get("/roles", ctrlListarRoles);
router.post("/roles", ctrlCrearRol);
router.patch("/roles/:id", ctrlActualizarRol);
router.delete("/roles/:id", ctrlEliminarRol);

export default router;
