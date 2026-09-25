import { Router } from "express";
import multer from "multer";
import { verificarToken, exigirGestionArchivos } from "../middlewares/auth.middleware";
import { validarUUID } from "../middlewares/validarUUID.middleware";
import { limitadorSubida, limiteBacklogUsuario } from "../middlewares/limites.middleware";
import {
  ctrlSubir,
  ctrlListar,
  ctrlBuscar,
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
  ctrlDescribir,
} from "../controllers/archivos.controller";
import { AppError } from "../utils/errors";
import { TIPOS_PERMITIDOS, MENSAJE_TIPO_NO_PERMITIDO } from "../utils/tiposArchivo";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  // fileFilter se ejecuta antes de guardar el archivo. Primera barrera: rechaza
  // por el mimeType declarado. La segunda barrera (magic bytes del CONTENIDO real,
  // infalsificable) la aplica el controlador con validarContenidoArchivo.
  fileFilter: (_req, file, cb) => {
    if ((TIPOS_PERMITIDOS as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, MENSAJE_TIPO_NO_PERMITIDO));
    }
  },
});

// Todas las rutas requieren token valido (verificarToken)
// Las rutas con :id ademas validan que el ID sea un UUID (validarUUID)
//
// RBAC: las rutas que MODIFICAN (subir, mover, copiar, renombrar, borrar,
// papelera, carpetas) exigen la capacidad "gestion_archivos". Las de LECTURA
// (listar, ver, descargar, buscar) no: quien no la tenga sigue viendo sus
// archivos, pero no puede cambiarlos. admin/superadmin la tienen siempre.

router.post(
  "/subir",
  verificarToken,
  exigirGestionArchivos,
  limitadorSubida,
  limiteBacklogUsuario,
  upload.single("archivo"),
  ctrlSubir,
);
router.get("/", verificarToken, ctrlListar);
router.get("/buscar", verificarToken, ctrlBuscar);
router.get("/papelera", verificarToken, ctrlPapelera);
router.get("/carpeta/descargar", verificarToken, ctrlDescargarCarpeta);
// Carpetas (metadata): listar / crear / mover-renombrar / borrar
router.get("/carpetas", verificarToken, ctrlListarCarpetas);
router.post("/carpetas", verificarToken, exigirGestionArchivos, ctrlCrearCarpeta);
router.patch("/carpetas", verificarToken, exigirGestionArchivos, ctrlReubicarCarpeta);
router.delete("/carpetas", verificarToken, exigirGestionArchivos, ctrlEliminarCarpeta);
// IMPORTANTE: las rutas con segmento fijo ("/papelera") van ANTES de "/:id",
// si no, "/:id" capturaría "papelera" como si fuera un id.
router.delete("/papelera", verificarToken, exigirGestionArchivos, ctrlVaciarPapelera);
router.patch("/:id", verificarToken, exigirGestionArchivos, validarUUID, ctrlActualizar);
router.post("/:id/copiar", verificarToken, exigirGestionArchivos, validarUUID, ctrlCopiar);
router.patch("/:id/restaurar", verificarToken, exigirGestionArchivos, validarUUID, ctrlRestaurar);
router.patch("/:id/descripcion", verificarToken, exigirGestionArchivos, validarUUID, ctrlDescribir);
router.get("/:id", verificarToken, validarUUID, ctrlObtener);
router.get("/:id/descargar", verificarToken, validarUUID, ctrlDescargar);
router.delete("/:id/permanente", verificarToken, exigirGestionArchivos, validarUUID, ctrlBorrarPermanente);
router.delete("/:id", verificarToken, exigirGestionArchivos, validarUUID, ctrlEliminar);

export default router;
