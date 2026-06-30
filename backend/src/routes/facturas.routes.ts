import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { limitadorEscaneo, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import { ctrlEscanear, ctrlListarFacturas } from "../controllers/facturas.controller";

const router = Router();

router.post("/escanear", verificarToken, limitadorEscaneo, limiteBacklogUsuario, ctrlEscanear);
router.get("/", verificarToken, ctrlListarFacturas);

export default router;
