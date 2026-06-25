import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { ctrlEscanear, ctrlListarFacturas } from "../controllers/facturas.controller";

const router = Router();

router.post("/escanear", verificarToken, ctrlEscanear);
router.get("/", verificarToken, ctrlListarFacturas);

export default router;
