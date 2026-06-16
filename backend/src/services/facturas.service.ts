import { createWorker, Worker } from "tesseract.js";
import { AppDataSource } from "../config/database";
import { env } from "../config/env";
import { minioClient } from "../config/minio";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";
import { AppError } from "../utils/errors";
import { extraerTexto } from "./extraccion.service";
import { crearArchivoTexto, borrarPermanente } from "./archivos.service";

const CARPETA_FACTURAS = "/facturas";

// --- OCR (Tesseract) ---
// Worker perezoso: inicializarlo es caro, así que se crea una vez y se reutiliza.
let workerPromise: Promise<Worker> | null = null;
const getWorker = (): Promise<Worker> => {
  if (!workerPromise) workerPromise = createWorker("spa");
  return workerPromise;
};
const ocrImagen = async (buffer: Buffer): Promise<string> => {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  return data.text ?? "";
};

// Lee un objeto de MinIO completo a un Buffer.
const obtenerBufferMinio = async (archivo: Archivo): Promise<Buffer> => {
  const stream = await minioClient.getObject(env.MINIO_BUCKET, archivo.claveMinio);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

// Obtiene el texto de la factura: OCR si es imagen, extracción si es PDF/texto.
// Añade la "pista" del usuario si la hay. Lanza si no consigue nada.
const leerContenidoFactura = async (archivo: Archivo, pista?: string): Promise<string> => {
  const buffer = await obtenerBufferMinio(archivo);
  let texto = "";
  if (/^image\//.test(archivo.mimeType)) {
    texto = await ocrImagen(buffer);
  } else {
    texto = (await extraerTexto(buffer, archivo.mimeType, archivo.nombre)) ?? "";
  }
  const extra = pista?.trim() ? `\n\nINFO ADICIONAL DEL USUARIO: ${pista.trim()}` : "";
  const completo = (texto + extra).trim();
  if (!completo) {
    throw new AppError(
      422,
      "No pude leer el contenido del archivo. Indica qué contiene (pista).",
    );
  }
  return completo;
};

// --- Extracción estructurada con la IA ---
interface DatosFactura {
  numero?: string;
  fecha?: string;
  emisor?: string;
  cliente?: string;
  subtotal?: number;
  iva?: number;
  total?: number;
  lineas?: { descripcion: string; cantidad?: number; precioUnit?: number; total?: number }[];
}

// JSON schema que se le pasa a Ollama (format) para forzar una salida estructurada.
const SCHEMA_FACTURA = {
  type: "object",
  properties: {
    numero: { type: "string" },
    fecha: { type: "string" },
    emisor: { type: "string" },
    cliente: { type: "string" },
    subtotal: { type: "number" },
    iva: { type: "number" },
    total: { type: "number" },
    lineas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          descripcion: { type: "string" },
          cantidad: { type: "number" },
          precioUnit: { type: "number" },
          total: { type: "number" },
        },
        required: ["descripcion"],
      },
    },
  },
  required: ["numero", "fecha", "emisor", "cliente", "subtotal", "iva", "total", "lineas"],
};

const extraerDatosFactura = async (contenido: string): Promise<DatosFactura> => {
  const messages = [
    {
      role: "system",
      content:
        "Extrae TODOS los datos de la factura del texto y devuélvelos en JSON. Rellena: numero (nº de factura), fecha (ISO YYYY-MM-DD), emisor (quién la emite), cliente (a quién se factura), subtotal, iva, total, y lineas (un objeto por artículo: descripcion, cantidad, precioUnit, total). Rellena TODOS los campos que aparezcan en el texto; no dejes vacío lo que sí está. Los importes como números, sin símbolo de moneda. No inventes datos que no aparezcan.",
    },
    { role: "user", content: contenido },
  ];
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        stream: false,
        format: SCHEMA_FACTURA,
        options: { temperature: 0 },
      }),
    });
  } catch {
    throw new AppError(503, "No se puede conectar con la IA para procesar la factura.");
  }
  const data = (await res.json()) as { message?: { content?: string }; error?: string };
  if (!res.ok || data.error || !data.message?.content) {
    throw new AppError(503, `La IA no pudo procesar la factura: ${data.error ?? res.status}`);
  }
  try {
    return JSON.parse(data.message.content) as DatosFactura;
  } catch {
    throw new AppError(503, "La IA devolvió un formato inesperado al leer la factura.");
  }
};

// Normaliza la fecha a ISO (YYYY-MM-DD); admite dd/mm/aaaa. null si no es válida.
const normalizarFecha = (f?: string): string | null => {
  if (!f) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(f);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
};

// Crea un archivo de texto reemplazando cualquier otro activo con el mismo nombre
// en la carpeta (para no acumular duplicados de los .md de resumen).
const reemplazarArchivoTexto = async (
  usuarioId: string,
  nombre: string,
  carpeta: string,
  contenido: string,
): Promise<void> => {
  const repo = AppDataSource.getRepository(Archivo);
  const existentes = await repo.find({
    where: { nombre, carpeta, propietario: { id: usuarioId } },
  });
  for (const a of existentes) await borrarPermanente(a.id, usuarioId);
  await crearArchivoTexto(usuarioId, nombre, carpeta, contenido);
};

const eur = (n: number | string): string => `${Number(n).toFixed(2)} €`;

// --- API pública del servicio ---

// Escanea una factura (PDF/imagen), guarda los datos en BD y genera los resúmenes.
export const escanearFactura = async (
  usuarioId: string,
  archivoId: string,
  pista?: string,
): Promise<{ numero?: string; total?: number; lineas: number; resumen: string }> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivo = await archivoRepo.findOne({
    where: { id: archivoId },
    relations: { propietario: true },
  });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso sobre este archivo");
  }

  const contenido = await leerContenidoFactura(archivo, pista);
  const datos = await extraerDatosFactura(contenido);

  const facturaRepo = AppDataSource.getRepository(Factura);
  // Si ya se había escaneado este archivo, reemplazamos su factura (y sus líneas por CASCADE).
  await facturaRepo
    .createQueryBuilder()
    .delete()
    .where(`"archivoId" = :a AND "propietarioId" = :u`, { a: archivo.id, u: usuarioId })
    .execute();

  const factura = facturaRepo.create({
    propietario: { id: usuarioId } as Usuario,
    archivo: { id: archivo.id } as Archivo,
    numero: datos.numero,
    fecha: normalizarFecha(datos.fecha),
    emisor: datos.emisor,
    cliente: datos.cliente,
    subtotal: String(datos.subtotal ?? 0),
    iva: String(datos.iva ?? 0),
    total: String(datos.total ?? 0),
    lineas: (datos.lineas ?? []).map(
      (l) =>
        ({
          descripcion: l.descripcion,
          cantidad: String(l.cantidad ?? 0),
          precioUnit: String(l.precioUnit ?? 0),
          total: String(l.total ?? 0),
        }) as LineaFactura,
    ),
  });
  const guardada = await facturaRepo.save(factura); // cascade guarda las líneas

  // Resumen por factura + regenerar el resumen global de ventas.
  // Si falla la creación de los .md (p. ej. MinIO), logueamos pero no abortamos:
  // los datos de la factura ya están guardados en BD y eso es lo importante.
  const idCorto = (datos.numero ?? guardada.id.slice(0, 8)).replace(/[^\w.-]/g, "_");
  try {
    await reemplazarArchivoTexto(
      usuarioId,
      `resumen-factura-${idCorto}.md`,
      CARPETA_FACTURAS,
      resumenFacturaMd(datos),
    );
    await regenerarResumenVentas(usuarioId);
  } catch (err) {
    console.error("[facturas] Error al crear archivos de resumen (no crítico):", err);
  }

  return {
    numero: datos.numero,
    total: datos.total,
    lineas: datos.lineas?.length ?? 0,
    resumen: resumenFacturaMd(datos),
  };
};

const resumenFacturaMd = (d: DatosFactura): string => {
  const lineas = (d.lineas ?? [])
    .map((l) => `| ${l.descripcion} | ${l.cantidad ?? 0} | ${eur(l.precioUnit ?? 0)} | ${eur(l.total ?? 0)} |`)
    .join("\n");
  return `# Resumen factura ${d.numero ?? ""}

- **Fecha:** ${d.fecha ?? "—"}
- **Emisor:** ${d.emisor ?? "—"}
- **Cliente:** ${d.cliente ?? "—"}

| Artículo | Cantidad | Precio | Total |
|---|---|---|---|
${lineas}

- **Subtotal:** ${eur(d.subtotal ?? 0)}
- **IVA:** ${eur(d.iva ?? 0)}
- **TOTAL:** ${eur(d.total ?? 0)}
`;
};

// Lee los datos de una factura YA ESCANEADA desde la BD (sin re-procesar el PDF).
export const obtenerFactura = async (
  usuarioId: string,
  nombreArchivo: string,
): Promise<{ encontrada: boolean; resumen?: string; numero?: string }> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivos = await archivoRepo
    .createQueryBuilder("a")
    .where("a.propietarioId = :uid", { uid: usuarioId })
    .andWhere("a.nombre ILIKE :n", { n: `%${nombreArchivo}%` })
    .andWhere("a.eliminadoEn IS NULL")
    .getMany();
  if (archivos.length === 0) return { encontrada: false };

  const facturaRepo = AppDataSource.getRepository(Factura);
  const factura = await facturaRepo.findOne({
    where: { archivo: { id: archivos[0].id }, propietario: { id: usuarioId } },
    relations: { lineas: true },
  });
  if (!factura) return { encontrada: false };

  const datos: DatosFactura = {
    numero: factura.numero,
    fecha: factura.fecha ?? undefined,
    emisor: factura.emisor,
    cliente: factura.cliente,
    subtotal: Number(factura.subtotal),
    iva: Number(factura.iva),
    total: Number(factura.total),
    lineas: factura.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnit: Number(l.precioUnit),
      total: Number(l.total),
    })),
  };
  return { encontrada: true, resumen: resumenFacturaMd(datos), numero: factura.numero };
};

// Ranking de productos más vendidos (por importe), opcionalmente en un rango de fechas.
export const ventasTop = async (
  usuarioId: string,
  rango: { desde?: string; hasta?: string } = {},
  limite = 10,
): Promise<{ producto: string; unidades: number; importe: number }[]> => {
  const filas: { producto: string; unidades: number; importe: number }[] =
    await AppDataSource.query(
      `SELECT lower(l."descripcion") AS producto,
              SUM(l."cantidad")::float AS unidades,
              SUM(l."total")::float AS importe
       FROM "lineas_factura" l
       JOIN "facturas" f ON f."id" = l."facturaId"
       WHERE f."propietarioId" = $1
         AND ($2::date IS NULL OR f."fecha" >= $2::date)
         AND ($3::date IS NULL OR f."fecha" <= $3::date)
       GROUP BY lower(l."descripcion")
       ORDER BY importe DESC
       LIMIT $4`,
      [usuarioId, rango.desde ?? null, rango.hasta ?? null, limite],
    );
  return filas.map((r) => ({
    producto: r.producto,
    unidades: Number(r.unidades),
    importe: Number(r.importe),
  }));
};

// Totales globales de ventas + top productos.
export const resumenVentas = async (
  usuarioId: string,
): Promise<{ numFacturas: number; totalFacturado: number; top: { producto: string; unidades: number; importe: number }[] }> => {
  const [tot] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS num, COALESCE(SUM("total"), 0)::float AS facturado
     FROM "facturas" WHERE "propietarioId" = $1`,
    [usuarioId],
  );
  const top = await ventasTop(usuarioId, {}, 5);
  return { numFacturas: tot.num, totalFacturado: tot.facturado, top };
};

const regenerarResumenVentas = async (usuarioId: string): Promise<void> => {
  const { numFacturas, totalFacturado, top } = await resumenVentas(usuarioId);
  const ranking = top
    .map((t, i) => `${i + 1}. **${t.producto}** — ${t.unidades} ud. — ${eur(t.importe)}`)
    .join("\n");
  const md = `# Resumen de ventas

- **Facturas escaneadas:** ${numFacturas}
- **Total facturado:** ${eur(totalFacturado)}

## Más vendidos
${ranking || "_(todavía no hay datos)_"}
`;
  await reemplazarArchivoTexto(usuarioId, "resumen-ventas.md", CARPETA_FACTURAS, md);
};
