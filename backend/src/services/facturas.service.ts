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

// Lee un objeto de MinIO completo a un Buffer.
const obtenerBufferMinio = async (archivo: Archivo): Promise<Buffer> => {
  const stream = await minioClient.getObject(env.MINIO_BUCKET, archivo.claveMinio);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

// Obtiene el texto de la factura. Si el archivo ya se indexó para RAG (subida
// normal: PDF/imagen pasan por extraerTexto, que ya hace OCR de imágenes),
// reutiliza ese texto en vez de volver a leer el binario y repetir el OCR.
// Añade la "pista" del usuario si la hay. Lanza si no consigue nada.
const leerContenidoFactura = async (archivo: Archivo, pista?: string): Promise<string> => {
  let texto = archivo.textoExtraido ?? "";
  if (!texto) {
    const buffer = await obtenerBufferMinio(archivo);
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
  archivoNombre?: string;
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

// Serializa tareas por usuario: las que llegan para el mismo usuario se
// encadenan en vez de correr a la vez. Necesario porque el front sube varias
// imágenes EN PARALELO y cada subida acaba regenerando el MISMO archivo
// "resumen-ventas.md" (borrar+crear): sin serializar, dos ejecuciones a la vez
// podían dejar dos copias del .md o competir en el borrado.
// (Estado en memoria: válido para una sola instancia de API, como es el caso.)
const colaPorUsuario = new Map<string, Promise<unknown>>();
const enSerie = <T>(usuarioId: string, tarea: () => Promise<T>): Promise<T> => {
  const anterior = colaPorUsuario.get(usuarioId) ?? Promise.resolve();
  // .then(tarea, tarea): se ejecuta tanto si la anterior fue ok como si falló.
  const actual = anterior.then(tarea, tarea);
  // Guardamos una versión "tragada" para que un fallo no rompa la cadena.
  colaPorUsuario.set(usuarioId, actual.catch(() => {}));
  return actual;
};

// --- API pública del servicio ---

// Escanea una factura (PDF/imagen), guarda los datos en BD y genera los resúmenes.
// opts.soloSiFactura: para el auto-escaneo al subir; si el archivo no parece una
// factura (sin líneas ni importes), no guarda nada y devuelve { omitida: true }.
export const escanearFactura = async (
  usuarioId: string,
  archivoId: string,
  opts: { pista?: string; soloSiFactura?: boolean } = {},
): Promise<{ numero?: string; total?: number; lineas: number; resumen: string; omitida?: boolean }> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivo = await archivoRepo.findOne({
    where: { id: archivoId },
    relations: { propietario: true },
  });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso sobre este archivo");
  }

  const contenido = await leerContenidoFactura(archivo, opts.pista);
  const datos = await extraerDatosFactura(contenido);
  datos.archivoNombre = archivo.nombre;

  // Si no parece una factura real, no la guardamos. Exige TANTO un importe real
  // (no solo líneas con descripción: el modelo puede inventarse precios para algo
  // que no es una factura, ej. una lista de la compra o una foto sin texto) COMO
  // algún dato identificativo (número/fecha/emisor) — las dos cosas a la vez,
  // para no confundir una imagen cualquiera con una factura real. Antes esto solo
  // se aplicaba al auto-escaneo: el escaneo MANUAL nunca lo comprobaba, así que
  // ante una imagen sin contenido real el modelo igual inventaba una factura
  // completa (cliente, importes...) de la nada.
  const lineasConImporte = (datos.lineas ?? []).filter(
    (l) => l.descripcion?.trim() && (Number(l.total) > 0 || Number(l.precioUnit) > 0),
  );
  const tieneImportes =
    Number(datos.total) > 0 || Number(datos.subtotal) > 0 || lineasConImporte.length > 0;
  const tieneIdentificacion = !!(
    datos.numero?.trim() ||
    datos.fecha?.trim() ||
    datos.emisor?.trim()
  );
  if (!tieneImportes || !tieneIdentificacion) {
    if (opts.soloSiFactura) return { lineas: 0, resumen: "", omitida: true };
    throw new AppError(
      422,
      "No he encontrado datos reales de una factura en este archivo (ni importes ni número/fecha/emisor). Si es una imagen difícil de leer, indica los datos reales en la pista.",
    );
  }

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
    // Serializado por usuario: varias facturas escaneándose a la vez (subida
    // múltiple / "escanea todas") reescriben el mismo resumen-ventas.md.
    await enSerie(usuarioId, () => regenerarResumenVentas(usuarioId));
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

// ¿El archivo es candidato a factura (PDF o imagen)?
export const esArchivoFactura = (archivo: Archivo): boolean =>
  /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(archivo.nombre) ||
  /^(application\/pdf|image\/)/.test(archivo.mimeType);

// Auto-escaneo al subir: si el archivo parece una factura, intenta escanearlo en
// segundo plano. Solo persiste si la extracción tiene pinta de factura (soloSiFactura).
// Pensado para llamarse "fire-and-forget"; los errores se logean, no se propagan.
export const autoEscanearArchivo = async (
  usuarioId: string,
  archivo: Archivo,
): Promise<void> => {
  if (!esArchivoFactura(archivo)) return;
  const r = await escanearFactura(usuarioId, archivo.id, { soloSiFactura: true });
  if (!r.omitida) {
    console.log(`[facturas] Auto-escaneada "${archivo.nombre}" (${r.lineas} línea/s)`);
  }
};

const resumenFacturaMd = (d: DatosFactura): string => {
  const lineas = (d.lineas ?? [])
    .map((l) => `| ${l.descripcion} | ${l.cantidad ?? 0} | ${eur(l.precioUnit ?? 0)} | ${eur(l.total ?? 0)} |`)
    .join("\n");
  const titulo = [d.numero, d.archivoNombre].filter(Boolean).join(" — ");
  return `## Factura ${titulo || "sin número"}

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
  archivoId: string,
  archivoNombre?: string,
): Promise<{ encontrada: boolean; resumen?: string; numero?: string }> => {
  const facturaRepo = AppDataSource.getRepository(Factura);
  const factura = await facturaRepo.findOne({
    where: { archivo: { id: archivoId }, propietario: { id: usuarioId } },
    relations: { lineas: true },
  });
  if (!factura) return { encontrada: false };

  const datos: DatosFactura = {
    numero: factura.numero,
    archivoNombre,
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

// Filtro común para las consultas analíticas de facturas. Todos los campos son
// opcionales y se combinan en AND. `facturas` admite nº de factura o nombre de
// archivo (se busca en ambos). `producto` solo aplica a los rankings.
export interface FiltroFacturas {
  facturas?: string[];
  cliente?: string;
  emisor?: string;
  desde?: string;
  hasta?: string;
  producto?: string;
}

// Construye las condiciones WHERE y los parámetros posicionales a partir del filtro.
// Asume que la consulta tiene alias "f" (facturas) y "a" (LEFT JOIN archivos).
// $1 es siempre el usuario.
const construirFiltro = (
  usuarioId: string,
  filtro: FiltroFacturas,
): { where: string; params: unknown[] } => {
  // Excluye facturas cuyo archivo está en la papelera: sin esto, una factura
  // borrada seguía contando en ventas_top/totales_facturas (el registro de
  // Factura en BD no depende del archivo para "existir" en estas consultas).
  // a."id" IS NULL cubre el caso (raro) de una factura sin archivo asociado.
  const cond: string[] = [`f."propietarioId" = $1`, `(a."id" IS NULL OR a."eliminadoEn" IS NULL)`];
  const params: unknown[] = [usuarioId];
  const add = (valor: unknown): string => {
    params.push(valor);
    return `$${params.length}`;
  };

  if (filtro.facturas?.length) {
    // Cada identificador puede coincidir con el nº de factura o el nombre de archivo.
    // Regex con límites de dígito (~*) para que "1" case con "factura_1.pdf" pero
    // NO con "factura_10.pdf"/"factura_21.pdf" (ILIKE %1% era demasiado amplio).
    const ors = filtro.facturas
      .map((id) => String(id).trim())
      .filter(Boolean)
      .map((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const p = add(`(^|[^0-9])${escaped}([^0-9]|$)`);
        return `(f."numero" ~* ${p} OR a."nombre" ~* ${p})`;
      });
    if (ors.length) cond.push(`(${ors.join(" OR ")})`);
  }
  // unaccent() en ambos lados: para que "Tecnologias" (sin tilde, lo más común
  // al escribir rápido) encuentre "Tecnologías".
  if (filtro.cliente?.trim())
    cond.push(`unaccent(f."cliente") ILIKE unaccent(${add(`%${filtro.cliente.trim()}%`)})`);
  if (filtro.emisor?.trim())
    cond.push(`unaccent(f."emisor") ILIKE unaccent(${add(`%${filtro.emisor.trim()}%`)})`);
  if (filtro.desde) cond.push(`f."fecha" >= ${add(filtro.desde)}::date`);
  if (filtro.hasta) cond.push(`f."fecha" <= ${add(filtro.hasta)}::date`);
  if (filtro.producto?.trim())
    cond.push(`unaccent(l."descripcion") ILIKE unaccent(${add(`%${filtro.producto.trim()}%`)})`);

  return { where: cond.join(" AND "), params };
};

// Markdown de un ranking de productos (con € server-side).
export const rankingMd = (
  filas: { producto: string; unidades: number; importe: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay datos de ventas para esa consulta.";
  const cuerpo = filas
    .map((t, i) => `| ${i + 1} | ${t.producto} | ${t.unidades} | ${eur(t.importe)} |`)
    .join("\n");
  return `## ${titulo}\n\n| # | Producto | Unidades | Importe |\n|---|---|---|---|\n${cuerpo}`;
};

// Markdown de los totales facturados (con € server-side).
export const totalesMd = (
  t: { numFacturas: number; subtotal: number; iva: number; total: number },
  titulo: string,
): string => {
  if (t.numFacturas === 0) return "No hay facturas que cumplan esa consulta.";
  return `## ${titulo}\n\n- **Facturas:** ${t.numFacturas}\n- **Subtotal:** ${eur(t.subtotal)}\n- **IVA:** ${eur(t.iva)}\n- **TOTAL:** ${eur(t.total)}`;
};

// Ranking de productos (por importe) sobre las facturas que cumplen el filtro.
// orden 'desc' = más vendido (defecto); 'asc' = menos vendido.
export const ventasTop = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { orden?: "desc" | "asc"; limite?: number } = {},
): Promise<{ producto: string; unidades: number; importe: number }[]> => {
  const { where, params } = construirFiltro(usuarioId, filtro);
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  const filas: { producto: string; unidades: number; importe: number }[] =
    await AppDataSource.query(
      `SELECT lower(l."descripcion") AS producto,
              SUM(l."cantidad")::float AS unidades,
              SUM(l."total")::float AS importe
       FROM "lineas_factura" l
       JOIN "facturas" f ON f."id" = l."facturaId"
       LEFT JOIN "archivos" a ON a."id" = f."archivoId"
       WHERE ${where}
       GROUP BY lower(l."descripcion")
       ORDER BY unidades ${orden}
       LIMIT ${limiteParam}`,
      [...params, opts.limite ?? 10],
    );
  return filas.map((r) => ({
    producto: r.producto,
    unidades: Number(r.unidades),
    importe: Number(r.importe),
  }));
};

// Totales facturados (nº facturas, subtotal, IVA, total) sobre el filtro dado.
// El campo `producto` del filtro no aplica aquí (son totales de cabecera).
export const totalesFacturado = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
): Promise<{ numFacturas: number; subtotal: number; iva: number; total: number }> => {
  const { producto: _producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, rest);
  const [row] = await AppDataSource.query(
    `SELECT COUNT(DISTINCT f."id")::int AS numfacturas,
            COALESCE(SUM(f."subtotal"), 0)::float AS subtotal,
            COALESCE(SUM(f."iva"), 0)::float AS iva,
            COALESCE(SUM(f."total"), 0)::float AS total
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${where}`,
    params,
  );
  return {
    numFacturas: Number(row.numfacturas),
    subtotal: Number(row.subtotal),
    iva: Number(row.iva),
    total: Number(row.total),
  };
};

// Ranking de clientes por gasto total. orden 'desc' = quién más gastó (defecto);
// 'asc' = quién menos. El campo `producto` del filtro no aplica aquí (no hay
// JOIN con lineas_factura, igual que en totalesFacturado).
export const clientesTop = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
  opts: { orden?: "desc" | "asc"; limite?: number } = {},
): Promise<{ cliente: string; numFacturas: number; importe: number }[]> => {
  const { producto: _producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, rest);
  const orden = opts.orden === "asc" ? "ASC" : "DESC";
  const limiteParam = `$${params.length + 1}`;
  const filas: { cliente: string; numfacturas: string; importe: string }[] =
    await AppDataSource.query(
      `SELECT f."cliente" AS cliente,
              COUNT(*)::int AS numfacturas,
              SUM(f."total")::float AS importe
       FROM "facturas" f
       LEFT JOIN "archivos" a ON a."id" = f."archivoId"
       WHERE ${where} AND f."cliente" IS NOT NULL AND f."cliente" <> ''
       GROUP BY f."cliente"
       ORDER BY importe ${orden}
       LIMIT ${limiteParam}`,
      [...params, opts.limite ?? 10],
    );
  return filas.map((r) => ({
    cliente: r.cliente,
    numFacturas: Number(r.numfacturas),
    importe: Number(r.importe),
  }));
};

// Markdown de un ranking de clientes por gasto total (con € server-side).
export const clientesTopMd = (
  filas: { cliente: string; numFacturas: number; importe: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay datos de clientes para esa consulta.";
  const cuerpo = filas
    .map((c, i) => `| ${i + 1} | ${c.cliente} | ${c.numFacturas} | ${eur(c.importe)} |`)
    .join("\n");
  return `## ${titulo}\n\n| # | Cliente | Facturas | Importe |\n|---|---|---|---|\n${cuerpo}`;
};

// Dado un conjunto de identificadores (nº/nombre de archivo), localiza los ficheros
// de factura que casan y escanea los que aún NO estén escaneados. Devuelve cuántos
// escaneó. Sirve para que las consultas analíticas funcionen aunque el usuario no
// haya escaneado antes esas facturas.
export const asegurarFacturasEscaneadas = async (
  usuarioId: string,
  identificadores: string[],
): Promise<number> => {
  const ids = identificadores.map((s) => String(s).trim()).filter(Boolean);
  if (ids.length === 0) return 0;

  const archivoRepo = AppDataSource.getRepository(Archivo);
  const qb = archivoRepo
    .createQueryBuilder("a")
    .where("a.propietarioId = :uid", { uid: usuarioId })
    .andWhere("a.eliminadoEn IS NULL");
  // Mismo matching con límites de dígito que el filtro de analítica.
  const ors = ids.map((_, i) => `a."nombre" ~* :re${i}`);
  qb.andWhere(`(${ors.join(" OR ")})`);
  ids.forEach((id, i) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    qb.setParameter(`re${i}`, `(^|[^0-9])${escaped}([^0-9]|$)`);
  });
  const archivos = await qb.getMany();

  // Solo ficheros que parezcan factura (PDF/imagen).
  const facturasArchivo = archivos.filter(
    (a) =>
      /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(a.nombre) ||
      /^(application\/pdf|image\/)/.test(a.mimeType),
  );
  if (facturasArchivo.length === 0) return 0;

  const facturaRepo = AppDataSource.getRepository(Factura);
  let escaneadas = 0;
  for (const archivo of facturasArchivo) {
    const ya = await facturaRepo.findOne({
      where: { archivo: { id: archivo.id }, propietario: { id: usuarioId } },
    });
    if (ya) continue; // ya estaba escaneada
    try {
      await escanearFactura(usuarioId, archivo.id);
      escaneadas++;
    } catch {
      // Si un archivo no se puede escanear, lo ignoramos y seguimos con los demás.
    }
  }
  return escaneadas;
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
  const top = await ventasTop(usuarioId, {}, { limite: 5 });
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
