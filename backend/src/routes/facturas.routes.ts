import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { ctrlEscanear } from "../controllers/facturas.controller";

const router = Router();

router.post("/escanear", verificarToken, ctrlEscanear);

export default router;
