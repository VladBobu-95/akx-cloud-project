import { AppDataSource } from "../config/database";
import { Archivo } from "../entities/Archivo";
import { extraerTexto } from "./extraccion.service";

const archivoRepo = () => AppDataSource.getRepository(Archivo);

// Contenido legible de cada archivo: el texto extraído automáticamente
// (PDF/DOCX/OCR) y la descripción manual del usuario. Se guardan en columnas
// separadas (ver `combinarContenido` en archivos.service.ts) para que el OCR en
// segundo plano y el modal de descripción manual no se pisen según cuál termine
// antes. El chat los lee por SQL (columna `contenido` de la vista chat.archivos)
// y el escaneo de facturas parte de ellos.

// Máximo de texto extraído que se guarda por archivo.
const MAX_TEXTO = 20000;

export const actualizarTextoExtraido = async (archivoId: string, texto: string): Promise<void> => {
  await archivoRepo().update(archivoId, { textoExtraido: texto.slice(0, MAX_TEXTO) });
};

// Descripción manual del usuario (modal "¿Qué es esta imagen?" o pista al escanear).
export const actualizarDescripcionManual = async (
  archivoId: string,
  descripcion: string,
): Promise<void> => {
  await archivoRepo().update(archivoId, { descripcionManual: descripcion });
};

// ---------------------------------------------------------------------------
// Buscador del explorador (Mis archivos y cada carpeta compartida): búsqueda
// NORMAL por texto, sin IA. Un archivo coincide si TODAS las palabras de la
// consulta aparecen (sin distinguir mayúsculas ni tildes, también a medias:
// "presu" encuentra "Presupuesto") en su nombre o en su contenido.
// ---------------------------------------------------------------------------

export interface ResultadoBusqueda {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string; // trozo del contenido donde aparece la búsqueda ("" si solo casa el nombre)
}

const MAX_RESULTADOS = 30;
const VENTANA_FRAGMENTO = 300;

const sinTildes = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Palabras de la consulta (sin repetir, de al menos 2 caracteres).
const palabras = (q: string): string[] =>
  [...new Set(sinTildes(q).split(/[^\p{L}\p{N}]+/u))].filter((p) => p.length >= 2);

// Escapa los comodines de LIKE para buscar el texto tal cual.
const escaparLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

// Trozo del contenido alrededor de la primera palabra encontrada. La versión sin
// tildes conserva un carácter por letra, así que las posiciones valen para el original.
const fragmentoDe = (contenido: string, buscadas: string[]): string => {
  const texto = contenido.replace(/\s+/g, " ").trim();
  const norm = sinTildes(texto);
  const pos = buscadas.map((p) => norm.indexOf(p)).filter((i) => i >= 0);
  if (pos.length === 0) return "";
  const inicio = Math.max(0, Math.min(...pos) - 80);
  const fin = Math.min(texto.length, inicio + VENTANA_FRAGMENTO);
  return (inicio > 0 ? "…" : "") + texto.slice(inicio, fin) + (fin < texto.length ? "…" : "");
};

// `filtroAcceso` acota el ámbito (personal o una carpeta compartida) con sus
// parámetros a partir de $1; el llamador ya ha comprobado el acceso.
const buscarConFiltro = async (
  consulta: string,
  filtroAcceso: string,
  paramsAcceso: unknown[],
): Promise<ResultadoBusqueda[]> => {
  const buscadas = palabras(consulta ?? "");
  if (buscadas.length === 0) return [];

  const base = paramsAcceso.length;
  const texto = `unaccent(a."nombre" || ' ' || coalesce(a."descripcionManual", '') || ' ' || coalesce(a."textoExtraido", ''))`;
  const condiciones = buscadas.map((_, i) => `${texto} ILIKE unaccent($${base + i + 1})`);
  const enNombre = buscadas.map((_, i) => `unaccent(a."nombre") ILIKE unaccent($${base + i + 1})`);

  const filas: {
    id: string;
    nombre: string;
    carpeta: string;
    contenido: string | null;
  }[] = await AppDataSource.query(
    `SELECT a."id", a."nombre", a."carpeta",
            concat_ws(' ', a."descripcionManual", a."textoExtraido") AS contenido
     FROM "archivos" a
     WHERE ${filtroAcceso}
       AND a."eliminadoEn" IS NULL
       AND ${condiciones.join(" AND ")}
     ORDER BY (${enNombre.join(" AND ")}) DESC, a."actualizadoEn" DESC
     LIMIT ${MAX_RESULTADOS}`,
    [...paramsAcceso, ...buscadas.map((p) => `%${escaparLike(p)}%`)],
  );

  return filas.map((f) => ({
    archivoId: f.id,
    nombre: f.nombre,
    carpeta: f.carpeta,
    fragmento: f.contenido ? fragmentoDe(f.contenido, buscadas) : "",
  }));
};

// Solo lo PERSONAL del usuario: lo compartido tiene su propio buscador.
export const buscarEnPersonales = (usuarioId: string, consulta: string): Promise<ResultadoBusqueda[]> =>
  buscarConFiltro(consulta, `a."propietarioId" = $1 AND a."carpetaCompartidaId" IS NULL`, [usuarioId]);

export const buscarEnCompartidaTexto = (
  carpetaCompartidaId: string,
  consulta: string,
): Promise<ResultadoBusqueda[]> =>
  buscarConFiltro(consulta, `a."carpetaCompartidaId" = $1`, [carpetaCompartidaId]);

// Extrae el texto del binario y lo guarda. Devuelve si había texto.
export const indexarArchivo = async (archivo: Archivo, buffer: Buffer): Promise<boolean> => {
  const texto = await extraerTexto(buffer, archivo.mimeType, archivo.nombre);
  if (!texto) return false;
  await actualizarTextoExtraido(archivo.id, texto);
  return true;
};
