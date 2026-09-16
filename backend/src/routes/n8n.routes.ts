import { Router } from "express";
import multer from "multer";
import { verificarApiKeyN8n } from "../middlewares/n8n.middleware";
import { limitadorChat, limitadorSubida, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import { ctrlSubir } from "../controllers/archivos.controller";
import { ctrlChatN8n } from "../controllers/n8n.controller";
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
  (req, _res, next) => {
    req.permitirCopiaN8n = true;
    next();
  },
  limitadorSubida,
  limiteBacklogUsuario,
  upload.single("archivo"),
  ctrlSubir,
);

// POST /api/n8n/chat  JSON { "mensaje": "..." } (o el body de /api/chat).
// Misma tubería que el chatbot de la app, con la cuenta de N8N_USER_EMAIL.
router.post("/chat", verificarApiKeyN8n, limitadorChat, ctrlChatN8n);

export default router;
