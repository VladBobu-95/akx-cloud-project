import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { limitadorEscaneo, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import {
  ctrlEscanear,
  ctrlListarFacturas,
  ctrlObtenerFactura,
  ctrlActualizarFactura,
  ctrlReclasificar,
} from "../controllers/facturas.controller";

const router = Router();

router.post("/escanear", verificarToken, limitadorEscaneo, limiteBacklogUsuario, ctrlEscanear);
router.post("/reclasificar", verificarToken, ctrlReclasificar);
router.get("/", verificarToken, ctrlListarFacturas);
router.get("/:id", verificarToken, ctrlObtenerFactura);
router.patch("/:id", verificarToken, ctrlActualizarFactura);

export default router;
