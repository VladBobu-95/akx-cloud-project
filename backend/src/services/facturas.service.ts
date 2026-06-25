import { AppDataSource } from "../config/database";
import { env } from "../config/env";
import { Archivo } from "../entities/Archivo";
import { Usuario } from "../entities/Usuario";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";
import { AppError } from "../utils/errors";
import { crearArchivoTexto, borrarPermanente, combinarContenido } from "./archivos.service";
import { actualizarDescripcionManual } from "./rag.service";
import { pareceFacturaConImportes } from "./extraccion.service";

const CARPETA_FACTURAS = "/facturas";

// Contenido de la factura: el texto ya extraído (OCR/PDF/DOCX) combinado con
// la descripción manual del usuario, si la hay (ver `combinarContenido`). NO
// vuelve a lanzar el OCR aquí: el pipeline de subida (`indexarArchivo`) ya lo
// intentó siempre antes de llegar a este punto — repetirlo aquí solo duplicaba
// el coste de deepseek-ocr en imágenes sin texto real, sin ningún beneficio
// (mismo archivo, misma IA con temperature 0 → mismo resultado vacío otra vez).
// Añade la "pista" del usuario si la hay. Lanza si no consigue nada.
const leerContenidoFactura = (archivo: Archivo, pista?: string): string => {
  const texto = combinarContenido(archivo.textoExtraido, archivo.descripcionManual);
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
  // NO se marca ningún campo como required: con la decodificación restringida de
  // Ollama, exigir todos los campos obliga al modelo a INVENTAR valores cuando el
  // texto no los tiene (una foto sin factura salía como factura completa). Dejándolos
  // opcionales, la IA puede devolver lo que de verdad encuentre (o nada), y la guarda
  // de `escanearFactura` decide si hay datos suficientes para ser una factura.
  required: [],
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
  for (const a of existentes) {
    // Solo se borra si de verdad es un .md generado por este mismo mecanismo
    // (crearArchivoTexto le pone mimeType "text/markdown" SIEMPRE a los .md).
    // "resumen-ventas.md"/"resumen-<archivo>.md" son nombres que este sistema
    // trata como propios, pero por coincidencia (o porque alguien renombra/
    // mueve un archivo real a propósito) podría existir un archivo REAL con
    // ese mismo nombre+carpeta — sin este filtro, la próxima regeneración lo
    // borraría para siempre (borrarPermanente, sin pasar por la papelera)
    // solo por compartir nombre. Si no es un .md nuestro, se deja intacto;
    // a costa de que pueda quedar un nombre duplicado, mucho mejor que perder
    // datos del usuario.
    if (a.mimeType !== "text/markdown") {
      console.warn(
        `[facturas] "${nombre}" en ${carpeta} coincide con un archivo real (no se borra): ${a.id}`,
      );
      continue;
    }
    await borrarPermanente(a.id, usuarioId);
  }
  await crearArchivoTexto(usuarioId, nombre, carpeta, contenido);
};

const eur = (n: number | string): string => `${Number(n).toFixed(2)} €`;

// Nombre del archivo de resumen a partir del nombre original, sin extensión y
// con caracteres no seguros para nombre de archivo sustituidos (mismo criterio
// que el saneado de idCorto anterior, pero basado en el nombre real subido en
// vez del número de factura/UUID — más fácil de relacionar a simple vista con
// el archivo original en el explorador).
const nombreResumenFactura = (nombreOriginal: string): string => {
  const punto = nombreOriginal.lastIndexOf(".");
  const base = punto > 0 ? nombreOriginal.slice(0, punto) : nombreOriginal;
  return `resumen-${base.replace(/[^\w.-]/g, "_")}.md`;
};

// Formatea una fecha ISO (YYYY-MM-DD) como DD/MM/YYYY para mostrar al usuario.
export const formatearFecha = (iso: string): string => {
  const [anio, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${anio}`;
};

// Serializa tareas por usuario: las que llegan para el mismo usuario se
// encadenan en vez de correr a la vez. Necesario porque varias facturas
// escaneándose a la vez (subida múltiple / "escanea todas") acaban
// regenerando el MISMO archivo "resumen-ventas.md" (borrar+crear): sin
// serializar, dos ejecuciones a la vez podían dejar dos copias del .md o
// competir en el borrado.
// (Estado en memoria: válido para una sola instancia de API, como es el caso.)
const colasPorUsuario = new Map<string, Promise<unknown>>();
const enSerie = <T>(usuarioId: string, tarea: () => Promise<T>): Promise<T> => {
  const anterior = colasPorUsuario.get(usuarioId) ?? Promise.resolve();
  // .then(tarea, tarea): se ejecuta tanto si la anterior fue ok como si falló.
  const actual = anterior.then(tarea, tarea);
  // Guardamos una versión "tragada" para que un fallo no rompa la cadena.
  colasPorUsuario.set(usuarioId, actual.catch(() => {}));
  return actual;
};

// Prioridad dentro de cada cola: 0 = alta (PDFs y demás, rápidos: pdf-parse/
// texto plano, sin IA de visión), 1 = baja (imágenes, o trabajo derivado de
// ellas). Dentro de `colaExtraccion`, una factura PDF nueva (alta) siempre se
// atiende antes que una imagen ya OCR'eada (baja) que llegó primero.
export const PRIORIDAD_ALTA = 0;
export const PRIORIDAD_BAJA = 1;

interface TareaCola {
  prioridad: number;
  ejecutar: () => Promise<void>;
}

// Dos colas en vez de una: `colaOcr` (imágenes, necesitan deepseek-ocr) y
// `colaExtraccion` (extracción de datos de factura con qwen — PDFs directos,
// o imágenes ya OCR'eadas). El motivo: deepseek-ocr (~9.4GB de VRAM medidos
// en una 4070) y qwen2.5-coder:14b no caben juntos en la GPU, así que cada
// vez que el pipeline de UN archivo pasa de OCR a extracción, Ollama tiene que
// descargar un modelo para cargar el otro. Procesando por fases en vez de por
// archivo (todo el OCR pendiente con deepseek-ocr cargado, luego toda la
// extracción pendiente con qwen cargado) ese cambio de modelo pasa de "uno
// por imagen" a "uno por lote".
const colaOcr: TareaCola[] = [];
const colaExtraccion: TareaCola[] = [];
let procesandoColas = false;

// Array.prototype.sort es estable desde ES2019: dentro de la misma prioridad
// se mantiene el orden de llegada (FIFO).
const sacarSiguiente = (cola: TareaCola[]): TareaCola | undefined => {
  if (cola.length === 0) return undefined;
  cola.sort((a, b) => a.prioridad - b.prioridad);
  return cola.shift();
};

// Antes de cada paso de OCR, si ha llegado una factura nueva (prioridad alta)
// a `colaExtraccion`, se atiende primero — así una factura nunca espera a que
// termine un lote entero de imágenes, solo a que termine la que esté en
// marcha en ese instante (no hay interrupción de una request ya en marcha
// con Ollama: se descartó por demasiado costosa/arriesgada, ver conversación).
const procesarColas = async (): Promise<void> => {
  if (procesandoColas) return;
  procesandoColas = true;
  while (colaOcr.length > 0 || colaExtraccion.length > 0) {
    const urgente = colaExtraccion.some((t) => t.prioridad === PRIORIDAD_ALTA)
      ? sacarSiguiente(colaExtraccion)
      : undefined;
    const siguiente = urgente ?? sacarSiguiente(colaOcr) ?? sacarSiguiente(colaExtraccion);
    if (!siguiente) break;
    await siguiente.ejecutar();
  }
  procesandoColas = false;
};

const encolarEnCola = <T>(
  cola: TareaCola[],
  prioridad: number,
  tarea: () => Promise<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    cola.push({ prioridad, ejecutar: () => tarea().then(resolve, reject) });
    void procesarColas();
  });

// Encola una tarea de OCR/indexado de una imagen (fase 1: deepseek-ocr).
export const encolarOcr = <T>(tarea: () => Promise<T>): Promise<T> =>
  encolarEnCola(colaOcr, PRIORIDAD_BAJA, tarea);

// Encola una tarea de extracción de datos de factura (fase 2: qwen). Alta
// prioridad por defecto (PDFs); pasar PRIORIDAD_BAJA para las que vienen de
// una imagen ya OCR'eada.
export const encolarExtraccion = <T>(
  tarea: () => Promise<T>,
  prioridad: number = PRIORIDAD_ALTA,
): Promise<T> => encolarEnCola(colaExtraccion, prioridad, tarea);

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

  await archivoRepo.update(archivo.id, { estadoEscaneo: "escaneando" });
  try {
    const contenido = leerContenidoFactura(archivo, opts.pista);
    // Gate previo a la IA: solo extraemos si el contenido tiene ALGUNA señal de
    // factura (importes/palabras clave/dígitos). El SCHEMA_FACTURA marca todos
    // los campos como required, así que la decodificación restringida de Ollama
    // FUERZA al modelo a rellenarlos aunque el texto sea la descripción de una
    // foto sin facturas — y entonces inventa emisor/cliente/importes de la nada
    // (visto en producción: una foto de unos materiales salía como "Factura 1,
    // Empresa S.A., 141.60 €"). Si no parece factura, no llamamos a la IA y
    // dejamos que la guarda de abajo lo trate como "no_factura".
    const datos: DatosFactura = pareceFacturaConImportes(contenido)
      ? await extraerDatosFactura(contenido)
      : { lineas: [] };
    datos.archivoNombre = archivo.nombre;

    // ¿Parece una factura real? Exige TANTO un importe real (no solo líneas con
    // descripción: el modelo puede inventarse precios para algo que no es una
    // factura, ej. una lista de la compra) COMO algún dato identificativo
    // (número/fecha/emisor) — así no se guarda una factura inventada por la IA
    // a partir de cualquier PDF/imagen subido (la app admite subir de todo,
    // no solo facturas).
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
      await archivoRepo.update(archivo.id, { estadoEscaneo: "no_factura" });
      // Si un escaneo anterior llegó a guardar una factura (inventada) para este
      // archivo, ahora que sabemos que NO es factura la eliminamos: si no, seguiría
      // apareciendo en "abre X" y en la analítica pese a este resultado.
      const { affected } = await AppDataSource.getRepository(Factura)
        .createQueryBuilder()
        .delete()
        .where(`"archivoId" = :a AND "propietarioId" = :u`, { a: archivo.id, u: usuarioId })
        .execute();
      // Si de verdad había una factura guardada de un escaneo anterior, ya no
      // cuenta: regeneramos resumen-ventas.md para que deje de incluirla.
      if (affected) {
        await regenerarResumenVentasSerie(usuarioId).catch((err) =>
          console.error("[facturas] Error al regenerar resumen-ventas (no crítico):", err),
        );
      }
      if (opts.soloSiFactura) return { lineas: 0, resumen: "", omitida: true };

      // Escaneo MANUAL de algo que no es factura: ya no hay modal obligatorio
      // al subir una imagen, así que esta es la única forma de describirla a
      // mano. Solo se guarda la PISTA que el usuario haya dado (texto real
      // escrito por él), nunca una copia de archivo.textoExtraido — ese texto
      // ya está disponible por su cuenta (combinarContenido lo muestra como
      // "Texto detectado (OCR)"); copiarlo aquí también dejaba la descripción
      // manual idéntica al OCR sin que el usuario hubiera escrito nada, y se
      // mostraba mal etiquetada como "Descripción:" en vez de "Texto detectado
      // (OCR)" la próxima vez que se abriera el archivo.
      const piezas = [opts.pista?.trim()].filter((p): p is string => !!p);
      const nuevas = piezas.filter((p) => !archivo.descripcionManual?.includes(p));
      if (nuevas.length > 0) {
        const nuevaDescripcion = [archivo.descripcionManual?.trim(), ...nuevas]
          .filter(Boolean)
          .join("\n\n");
        await actualizarDescripcionManual(archivo.id, nuevaDescripcion, usuarioId);
      }

      throw new AppError(
        422,
        opts.pista?.trim()
          ? "No he encontrado datos reales de una factura en este archivo (ni importes ni número/fecha/emisor). He guardado lo que indicaste como descripción del archivo."
          : "No he encontrado datos reales de una factura en este archivo (ni importes ni número/fecha/emisor). Si es una imagen difícil de leer, indica qué contiene en la pista — se guardará como descripción.",
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
    await archivoRepo.update(archivo.id, { estadoEscaneo: "escaneada" });

    // Resumen por factura + regenerar el resumen global de ventas.
    // Si falla la creación de los .md (p. ej. MinIO), logueamos pero no abortamos:
    // los datos de la factura ya están guardados en BD y eso es lo importante.
    try {
      await reemplazarArchivoTexto(
        usuarioId,
        nombreResumenFactura(archivo.nombre),
        CARPETA_FACTURAS,
        resumenFacturaMd(datos),
      );
      await regenerarResumenVentasSerie(usuarioId);
    } catch (err) {
      console.error("[facturas] Error al crear archivos de resumen (no crítico):", err);
    }

    return {
      numero: datos.numero,
      total: datos.total,
      lineas: datos.lineas?.length ?? 0,
      resumen: resumenFacturaMd(datos),
    };
  } catch (err) {
    // Los 422 ("no parece factura", venga de aquí o del chequeo de importes
    // de más arriba que ya pone su propio "no_factura") son un resultado
    // esperado, no un fallo técnico — sin esto, "sin contenido legible" dejaba
    // el estado en "escaneando" para siempre (nunca pasaba a "no_factura").
    // Cualquier otra cosa sí es un fallo técnico real (Ollama caído, MinIO...).
    if (err instanceof AppError && err.statusCode === 422) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "no_factura" }).catch(() => {});
    } else if (!(err instanceof AppError)) {
      await archivoRepo.update(archivo.id, { estadoEscaneo: "error" }).catch(() => {});
    }
    throw err;
  }
};

// ¿El archivo es candidato a factura (PDF o imagen)?
export const esArchivoFactura = (archivo: Archivo): boolean =>
  /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(archivo.nombre) ||
  /^(application\/pdf|image\/)/.test(archivo.mimeType);

// Marca el archivo recién subido como "pendiente", para que la columna
// "Estado" del explorador muestre la animación desde el instante de la subida
// (antes de que el pipeline en segundo plano lo recoja). Se aplica a CUALQUIER
// archivo, no solo a los candidatos a factura: el indexado RAG (extracción de
// texto + embeddings) corre para todos, y el usuario debe ver que algo está
// pasando aunque luego no termine en ✓/✕ (ej. un .txt o una foto sin factura).
export const marcarPendiente = async (archivo: Archivo): Promise<void> => {
  archivo.estadoEscaneo = "pendiente";
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: "pendiente" });
};

// Marca el archivo como "en proceso" al arrancar el pipeline en segundo plano
// (indexado + auto-escaneo), también para cualquier archivo — así el spinner
// cubre el indexado RAG entero, no solo el escaneo de factura en sí.
export const marcarEnProceso = async (archivo: Archivo): Promise<void> => {
  archivo.estadoEscaneo = "escaneando";
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: "escaneando" });
};

// Al terminar el pipeline, si el archivo NO es candidato a factura no queda
// ningún estado final (escanearFactura ni se llega a invocar), así que el
// spinner se quedaría encendido para siempre si no lo limpiamos aquí.
export const limpiarEstadoSiNoEsFactura = async (archivo: Archivo): Promise<void> => {
  if (esArchivoFactura(archivo)) return;
  await AppDataSource.getRepository(Archivo).update(archivo.id, { estadoEscaneo: null });
};

// Escaneo MANUAL disparado desde el explorador (clic derecho → Escanear). NO
// espera al resultado: en una GPU pequeña la extracción puede tardar minutos y
// bloquear el modal con "Escaneando…" toda la espera era el peor punto de
// fricción. Valida propiedad/existencia (para devolver 404/403 al instante),
// marca "pendiente" y encola en la fase de extracción (el texto ya se extrajo al
// subir; escanear NO relanza OCR). El estado final ("escaneada"/"no_factura"/
// "error") lo deja `escanearFactura` y la columna "Estado" lo refleja con su
// polling — igual que el auto-escaneo al subir.
export const encolarEscaneoManual = async (
  usuarioId: string,
  archivoId: string,
  pista?: string,
): Promise<void> => {
  const archivoRepo = AppDataSource.getRepository(Archivo);
  const archivo = await archivoRepo.findOne({
    where: { id: archivoId },
    relations: { propietario: true },
  });
  if (!archivo) throw new AppError(404, "Archivo no encontrado");
  if (archivo.propietario.id !== usuarioId) {
    throw new AppError(403, "No tienes permiso sobre este archivo");
  }
  await marcarPendiente(archivo);
  void encolarExtraccion(() =>
    escanearFactura(usuarioId, archivoId, { pista })
      .then(() => undefined)
      // El estado (no_factura/error) ya lo deja escanearFactura en su catch;
      // aquí solo logueamos porque no hay nadie esperando la promesa.
      .catch((err) =>
        console.error(`[facturas] Escaneo manual de "${archivo.nombre}" falló:`, err),
      ),
  );
};

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

// Markdown de un listado de facturas (con € server-side). Se usa para "facturas
// de [mes/año]" cuando se pide el LISTADO, no el total agregado. Es el texto de
// respaldo para clientes sin UI (curl, etc.); el frontend renderiza estas mismas
// filas como una tabla con botón "Abrir" (ver `archivos` en chat.service.ts).
export const listadoFacturasMd = (
  filas: { archivoId: string | null; archivoNombre: string | null; numero: string; fecha: string; total: number }[],
  titulo: string,
): string => {
  if (filas.length === 0) return "No hay facturas que cumplan esa consulta.";
  const cuerpo = filas
    .map((f) => `- **${f.archivoNombre ?? f.numero}** (${formatearFecha(f.fecha)}): ${eur(f.total)}`)
    .join("\n");
  return `## ${titulo}\n\n${cuerpo}`;
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

// Lista (no agrega) las facturas que cumplen el filtro, con el archivo asociado
// para poder ofrecer un botón "Abrir" por cada una. El campo `producto` no
// aplica aquí (no hay JOIN con lineas_factura, igual que en totalesFacturado).
export const listarFacturas = async (
  usuarioId: string,
  filtro: FiltroFacturas = {},
): Promise<
  { archivoId: string | null; archivoNombre: string | null; numero: string; fecha: string; total: number }[]
> => {
  const { producto: _producto, ...rest } = filtro;
  const { where, params } = construirFiltro(usuarioId, rest);
  const filas: { archivoid: string | null; archivonombre: string | null; numero: string; fecha: string; total: string }[] =
    await AppDataSource.query(
      `SELECT a."id" AS archivoid, a."nombre" AS archivonombre, f."numero" AS numero,
              f."fecha"::text AS fecha, f."total" AS total
       FROM "facturas" f
       LEFT JOIN "archivos" a ON a."id" = f."archivoId"
       WHERE ${where}
       ORDER BY f."fecha" DESC`,
      params,
    );
  return filas.map((r) => ({
    archivoId: r.archivoid,
    archivoNombre: r.archivonombre,
    numero: r.numero,
    fecha: r.fecha,
    total: Number(r.total),
  }));
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

// Totales globales de ventas + top productos/clientes. Usa el mismo
// `construirFiltro` (sin filtro real, solo el usuario) que ventasTop/
// totalesFacturado, así que excluye igual las facturas cuyo archivo está en
// la papelera — antes este conteo iba por su cuenta con un COUNT(*) directo
// sobre "facturas" sin ese JOIN/exclusión, así que una factura borrada (o
// restaurada) no movía nunca este número.
export const resumenVentas = async (
  usuarioId: string,
): Promise<{
  numFacturas: number;
  totalFacturado: number;
  subtotal: number;
  iva: number;
  ticketMedio: number;
  primeraFecha: string | null;
  ultimaFecha: string | null;
  top: { producto: string; unidades: number; importe: number }[];
  clientes: { cliente: string; numFacturas: number; importe: number }[];
}> => {
  const { where, params } = construirFiltro(usuarioId, {});
  const [row] = await AppDataSource.query(
    `SELECT COUNT(DISTINCT f."id")::int AS numfacturas,
            COALESCE(SUM(f."subtotal"), 0)::float AS subtotal,
            COALESCE(SUM(f."iva"), 0)::float AS iva,
            COALESCE(SUM(f."total"), 0)::float AS total,
            MIN(f."fecha")::text AS primera,
            MAX(f."fecha")::text AS ultima
     FROM "facturas" f
     LEFT JOIN "archivos" a ON a."id" = f."archivoId"
     WHERE ${where}`,
    params,
  );
  const numFacturas = Number(row.numfacturas);
  const totalFacturado = Number(row.total);
  const [top, clientes] = await Promise.all([
    ventasTop(usuarioId, {}, { limite: 5 }),
    clientesTop(usuarioId, {}, { limite: 3 }),
  ]);
  return {
    numFacturas,
    totalFacturado,
    subtotal: Number(row.subtotal),
    iva: Number(row.iva),
    ticketMedio: numFacturas > 0 ? totalFacturado / numFacturas : 0,
    primeraFecha: row.primera ?? null,
    ultimaFecha: row.ultima ?? null,
    top,
    clientes,
  };
};

const regenerarResumenVentas = async (usuarioId: string): Promise<void> => {
  const {
    numFacturas,
    totalFacturado,
    subtotal,
    iva,
    ticketMedio,
    primeraFecha,
    ultimaFecha,
    top,
    clientes,
  } = await resumenVentas(usuarioId);
  const ranking = top
    .map((t, i) => `${i + 1}. **${t.producto}** — ${t.unidades} ud. — ${eur(t.importe)}`)
    .join("\n");
  const rankingClientes = clientes
    .map((c, i) => `${i + 1}. **${c.cliente}** — ${c.numFacturas} factura/s — ${eur(c.importe)}`)
    .join("\n");
  const periodo =
    primeraFecha && ultimaFecha
      ? `${formatearFecha(primeraFecha)} – ${formatearFecha(ultimaFecha)}`
      : "—";
  const md = `# Resumen de ventas

- **Facturas escaneadas:** ${numFacturas}
- **Periodo:** ${periodo}
- **Total facturado:** ${eur(totalFacturado)}
- **Subtotal:** ${eur(subtotal)}
- **IVA:** ${eur(iva)}
- **Ticket medio:** ${eur(ticketMedio)}

## Más vendidos
${ranking || "_(todavía no hay datos)_"}

## Mejores clientes
${rankingClientes || "_(todavía no hay datos)_"}
`;
  await reemplazarArchivoTexto(usuarioId, "resumen-ventas.md", CARPETA_FACTURAS, md);
};

// Wrapper público: serializa por usuario (ver `enSerie` más arriba) para que
// dos operaciones a la vez sobre archivos/facturas del mismo usuario (subida
// múltiple, borrar+restaurar rápido...) no compitan reescribiendo a la vez el
// mismo "resumen-ventas.md". Lo usan tanto este servicio como
// `archivos.service.ts`/`carpetas.service.ts` cada vez que cambia qué
// facturas están activas (se borran, se restauran, o se crean).
export const regenerarResumenVentasSerie = (usuarioId: string): Promise<void> =>
  enSerie(usuarioId, () => regenerarResumenVentas(usuarioId));
