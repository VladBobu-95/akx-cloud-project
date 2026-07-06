import { Request, Response, NextFunction } from "express";
import {
  encolarEscaneoManual,
  listarFacturas,
  listarFacturasPapelera,
  obtenerFacturaDetalle,
  actualizarFactura,
  schemaActualizarFactura,
  type FiltroFacturas,
} from "../services/facturas.service";
import { AppError } from "../utils/errors";

// POST /api/facturas/escanear  { archivoId, pista? }
// Dispara el escaneo en segundo plano y responde al instante (202): el OCR/IA
// puede tardar minutos. El resultado se ve en la columna "Estado" del explorador.
export const ctrlEscanear = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const archivoId = String(req.body.archivoId ?? "");
    if (!archivoId) throw new AppError(400, "Falta el archivoId");
    const pista = typeof req.body.pista === "string" ? req.body.pista : undefined;
    await encolarEscaneoManual(req.usuario!.id, archivoId, pista);
    res.status(202).json({ estado: "pendiente" });
  } catch (error) {
    next(error);
  }
};

// GET /api/facturas?cliente=&emisor=&carpeta=&moneda=&desde=&hasta=&facturas=a,b&papelera=true&pagina=&limite=
// Listado paginado de facturas. Lo usa el cuadro HTML del chat ("facturas de
// X cliente/carpeta/mes/papelera"): la 1ª página la devuelve el chat ya
// resuelta; las páginas siguientes las pide el frontend aquí directamente
// (mismo filtro), sin volver a pasar por el modelo.
export const ctrlListarFacturas = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const pagina = Number(req.query.pagina) || 1;
    const limite = Math.min(Number(req.query.limite) || 20, 100);
    if (req.query.papelera === "true") {
      res.json(await listarFacturasPapelera(req.usuario!.id, { pagina, limite }));
      return;
    }
    const filtro: FiltroFacturas = {};
    if (typeof req.query.cliente === "string" && req.query.cliente) filtro.cliente = req.query.cliente;
    if (typeof req.query.emisor === "string" && req.query.emisor) filtro.emisor = req.query.emisor;
    if (typeof req.query.carpeta === "string" && req.query.carpeta) filtro.carpeta = req.query.carpeta;
    if (typeof req.query.moneda === "string" && req.query.moneda) filtro.moneda = req.query.moneda;
    if (typeof req.query.desde === "string" && req.query.desde) filtro.desde = req.query.desde;
    if (typeof req.query.hasta === "string" && req.query.hasta) filtro.hasta = req.query.hasta;
    if (typeof req.query.facturas === "string" && req.query.facturas) {
      filtro.facturas = req.query.facturas.split(",").map((s) => s.trim()).filter(Boolean);
    }
    // La página de Facturas filtra por pestaña: venta | compra | desconocido.
    if (req.query.tipo === "venta" || req.query.tipo === "compra" || req.query.tipo === "desconocido") {
      filtro.tipo = req.query.tipo;
    }
    res.json(await listarFacturas(req.usuario!.id, filtro, { pagina, limite }));
  } catch (error) {
    next(error);
  }
};

// GET /api/facturas/:id — detalle completo (con líneas) para el editor.
export const ctrlObtenerFactura = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json(await obtenerFacturaDetalle(req.usuario!.id, String(req.params.id)));
  } catch (error) {
    next(error);
  }
};

// PATCH /api/facturas/:id — edición manual (corregir emisor/cliente/tipo/importes/líneas).
export const ctrlActualizarFactura = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaActualizarFactura.parse(req.body);
    res.json(await actualizarFactura(req.usuario!.id, String(req.params.id), datos));
  } catch (error) {
    next(error);
  }
};
