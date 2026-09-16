import { Router } from "express";
import multer from "multer";
import { verificarApiKeyN8n } from "../middlewares/n8n.middleware";
import { limitadorSubida, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import { ctrlSubir } from "../controllers/archivos.controller";
import { AppError } from "../utils/errors";
import { TIPOS_PERMITIDOS, MENSAJE_TIPO_NO_PERMITIDO } from "../utils/tiposArchivo";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((TIPOS_PERMITIDOS as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, MENSAJE_TIPO_NO_PERMITIDO));
    }
  },
});

// POST /api/n8n/facturas  (multipart, campo "archivo"; carpeta opcional)
// Misma tubería que /api/archivos/subir: guarda el fichero y el worker indexa
// + auto-escanea si parece factura. Auth: header X-Api-Key, no JWT.
router.post(
  "/facturas",
  verificarApiKeyN8n,
  limitadorSubida,
  limiteBacklogUsuario,
  upload.single("archivo"),
  ctrlSubir,
);

export default router;
