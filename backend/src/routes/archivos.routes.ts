import { Router } from "express";
import multer from "multer";
import { verificarToken } from "../middlewares/auth.middleware";
import { validarUUID } from "../middlewares/validarUUID.middleware";
import {
  ctrlSubir,
  ctrlListar,
  ctrlObtener,
  ctrlDescargar,
  ctrlEliminar,
  ctrlRestaurar,
  ctrlPapelera,
  ctrlBorrarPermanente,
  ctrlVaciarPapelera,
  ctrlCopiar,
  ctrlDescargarCarpeta,
  ctrlActualizar,
  ctrlListarCarpetas,
  ctrlCrearCarpeta,
  ctrlReubicarCarpeta,
  ctrlEliminarCarpeta,
  ctrlBuscarSemantica,
  ctrlDescribir,
} from "../controllers/archivos.controller";
import { AppError } from "../utils/errors";

const router = Router();

// Tipos de archivo permitidos
// La clave es el mimeType real del archivo, no la extensión
// (la extensión se puede cambiar fácilmente, el mimeType no)
const TIPOS_PERMITIDOS = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  // fileFilter se ejecuta antes de guardar el archivo
  // Si llamas a cb(null, false) el archivo se rechaza
  // Si llamas a cb(null, true) se acepta
  fileFilter: (_req, file, cb) => {
    if (TIPOS_PERMITIDOS.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          400,
          `Tipo de archivo no permitido: ${file.mimetype}. Permitidos: PDF, Word, Excel, texto, CSV, imágenes`,
        ),
      );
    }
  },
});

// Todas las rutas requieren token valido (verificarToken)
// Las rutas con :id ademas validan que el ID sea un UUID (validarUUID)

router.post("/subir", verificarToken, upload.single("archivo"), ctrlSubir);
router.get("/", verificarToken, ctrlListar);
router.get("/buscar", verificarToken, ctrlBuscarSemantica);
router.get("/papelera", verificarToken, ctrlPapelera);
router.get("/carpeta/descargar", verificarToken, ctrlDescargarCarpeta);
// Carpetas (metadata): listar / crear / mover-renombrar / borrar
router.get("/carpetas", verificarToken, ctrlListarCarpetas);
router.post("/carpetas", verificarToken, ctrlCrearCarpeta);
router.patch("/carpetas", verificarToken, ctrlReubicarCarpeta);
router.delete("/carpetas", verificarToken, ctrlEliminarCarpeta);
// IMPORTANTE: las rutas con segmento fijo ("/papelera") van ANTES de "/:id",
// si no, "/:id" capturaría "papelera" como si fuera un id.
router.delete("/papelera", verificarToken, ctrlVaciarPapelera);
router.patch("/:id", verificarToken, validarUUID, ctrlActualizar);
router.post("/:id/copiar", verificarToken, validarUUID, ctrlCopiar);
router.patch("/:id/restaurar", verificarToken, validarUUID, ctrlRestaurar);
router.patch("/:id/descripcion", verificarToken, validarUUID, ctrlDescribir);
router.get("/:id", verificarToken, validarUUID, ctrlObtener);
router.get("/:id/descargar", verificarToken, validarUUID, ctrlDescargar);
router.delete("/:id/permanente", verificarToken, validarUUID, ctrlBorrarPermanente);
router.delete("/:id", verificarToken, validarUUID, ctrlEliminar);

export default router;
