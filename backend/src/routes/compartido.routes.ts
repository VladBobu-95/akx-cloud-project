import { Router } from "express";
import multer from "multer";
import { verificarToken, soloAdmin } from "../middlewares/auth.middleware";
import { limitadorSubida, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import {
  ctrlListarAdmin,
  ctrlCrear,
  ctrlActualizar,
  ctrlEliminar,
  ctrlLogs,
  ctrlAccesibles,
  ctrlListarArchivos,
  ctrlSubir,
  ctrlDescargar,
  ctrlEliminarArchivo,
  ctrlListarTodos,
  ctrlListarSubcarpetas,
  ctrlCrearSubcarpeta,
  ctrlReubicarSubcarpeta,
  ctrlEliminarSubcarpeta,
  ctrlActualizarArchivo,
  ctrlCopiarArchivo,
  ctrlCopiarAPersonal,
  ctrlDescargarCarpetaZip,
} from "../controllers/compartido.controller";
import { AppError } from "../utils/errors";
import { TIPOS_PERMITIDOS, MENSAJE_TIPO_NO_PERMITIDO } from "../utils/tiposArchivo";

const router = Router();

// Mismos tipos/límites que la subida personal. La 2ª barrera (magic bytes) la
// aplica el controlador con validarContenidoArchivo.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((TIPOS_PERMITIDOS as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new AppError(400, MENSAJE_TIPO_NO_PERMITIDO));
  },
});

router.use(verificarToken);

// --- Gestión (admin) ---
router.get("/admin", soloAdmin, ctrlListarAdmin);
router.post("/admin", soloAdmin, ctrlCrear);
router.get("/admin/:id/logs", soloAdmin, ctrlLogs);
router.patch("/admin/:id", soloAdmin, ctrlActualizar);
router.delete("/admin/:id", soloAdmin, ctrlEliminar);

// --- Operaciones sobre un archivo compartido concreto (van antes de "/:id/...") ---
router.get("/archivo/:archivoId/descargar", ctrlDescargar);
router.patch("/archivo/:archivoId", ctrlActualizarArchivo);
router.post("/archivo/:archivoId/copiar", ctrlCopiarArchivo);
router.post("/archivo/:archivoId/copiar-a-personal", ctrlCopiarAPersonal);
router.delete("/archivo/:archivoId", ctrlEliminarArchivo);

// --- Uso (cualquier miembro con acceso) ---
router.get("/", ctrlAccesibles);
router.get("/:id/todos", ctrlListarTodos);
router.get("/:id/carpeta/descargar", ctrlDescargarCarpetaZip);
router.get("/:id/carpetas", ctrlListarSubcarpetas);
router.post("/:id/carpetas", ctrlCrearSubcarpeta);
router.patch("/:id/carpetas", ctrlReubicarSubcarpeta);
router.delete("/:id/carpetas", ctrlEliminarSubcarpeta);
router.get("/:id/archivos", ctrlListarArchivos);
router.post("/:id/subir", limitadorSubida, limiteBacklogUsuario, upload.single("archivo"), ctrlSubir);

export default router;
