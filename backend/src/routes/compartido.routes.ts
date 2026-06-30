import { Router } from "express";
import multer from "multer";
import { verificarToken, soloAdmin } from "../middlewares/auth.middleware";
import { limitadorSubida, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import {
  ctrlListarAdmin,
  ctrlCrear,
  ctrlActualizar,
  ctrlEliminar,
  ctrlAccesibles,
  ctrlListarArchivos,
  ctrlSubir,
  ctrlDescargar,
  ctrlEliminarArchivo,
} from "../controllers/compartido.controller";
import { AppError } from "../utils/errors";

const router = Router();

// Mismos tipos/límites que la subida personal.
const TIPOS_PERMITIDOS = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (TIPOS_PERMITIDOS.includes(file.mimetype)) cb(null, true);
    else cb(new AppError(400, `Tipo de archivo no permitido: ${file.mimetype}.`));
  },
});

router.use(verificarToken);

// --- Gestión (admin) ---
router.get("/admin", soloAdmin, ctrlListarAdmin);
router.post("/admin", soloAdmin, ctrlCrear);
router.patch("/admin/:id", soloAdmin, ctrlActualizar);
router.delete("/admin/:id", soloAdmin, ctrlEliminar);

// --- Operaciones sobre un archivo compartido concreto (van antes de "/:id/...") ---
router.get("/archivo/:archivoId/descargar", ctrlDescargar);
router.delete("/archivo/:archivoId", ctrlEliminarArchivo);

// --- Uso (cualquier miembro con acceso) ---
router.get("/", ctrlAccesibles);
router.get("/:id/archivos", ctrlListarArchivos);
router.post("/:id/subir", limitadorSubida, limiteBacklogUsuario, upload.single("archivo"), ctrlSubir);

export default router;
