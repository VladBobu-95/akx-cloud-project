import { Router } from "express";
import {
  ctrlListarEmpresas,
  ctrlCrearEmpresa,
  ctrlActualizarEmpresa,
  ctrlEliminarEmpresa,
} from "../controllers/plataforma.controller";
import { verificarToken, soloSuperadmin } from "../middlewares/auth.middleware";

const router = Router();

// Todo el panel de plataforma es exclusivo del superadmin.
router.use(verificarToken, soloSuperadmin);

router.get("/empresas", ctrlListarEmpresas);
router.post("/empresas", ctrlCrearEmpresa);
router.patch("/empresas/:id", ctrlActualizarEmpresa);
router.delete("/empresas/:id", ctrlEliminarEmpresa);

export default router;
