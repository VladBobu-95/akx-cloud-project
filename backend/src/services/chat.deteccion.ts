// Capa de DETECCIÓN de intenciones del chat, extraída de chat.service.ts para
// poder TESTEARLA sin BD ni Ollama (#7). La fiabilidad del asistente se apoya en
// estos regex (los modelos pequeños no son fiables con function calling, ver
// NOTAS.md); centralizarlos aquí y cubrirlos con tests evita regresiones cuando
// se ajusta una frase. Estas funciones son PURAS: reciben el texto del mensaje
// (ya en minúsculas y, donde se indica, sin tildes) y devuelven un booleano o
// una clasificación, sin efectos secundarios.
//
// IMPORTANTE: el comportamiento es idéntico al que tenían inline en
// chat.service.ts; los regex se copiaron verbatim.

// Quita tildes/diacríticos (NFD) para que "bórralo" case igual que "borralo":
// los pronombres enclíticos con tilde desplazan el acento y rompen \b y los
// patrones normales.
export const quitarTildes = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Distancia Damerau-Levenshtein (una transposición de adyacentes cuenta como 1),
// para detectar erratas como "fcaturas".
export const distanciaDamerau = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + costo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
};

// Detecta "factura(s)" tolerando una errata de 1 cambio. Restringido a palabras
// que empiezan por "f" para no disparar con palabras sueltas no relacionadas.
export const contieneFactura = (texto: string): boolean =>
  texto.split(/\s+/).some((palabra) => {
    const p = palabra.replace(/[^a-z]/gi, "");
    if (/^facturas?$/.test(p)) return true;
    if (!p.startsWith("f") || p.length < 6 || p.length > 9) return false;
    return distanciaDamerau(p, "factura") <= 1 || distanciaDamerau(p, "facturas") <= 1;
  });

// Patrones de verbo (admiten el pronombre enclítico pegado: "bórralo", "sácalos").
export const VERBO_BORRAR =
  "(?:borra(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)";
export const VERBO_RESTAURAR =
  "(?:restaura(?:r|lo|la|los|las)?|recupera(?:r|lo|la|los|las)?|saca(?:r|lo|la|los|las)?)";

// "restaura/recupera todo" o "restaura todos los archivos/ficheros/papelera".
// `msg` debe venir en minúsculas y SIN tildes.
export const detectarRestaurarTodo = (msgSinTildes: string): boolean =>
  new RegExp(`\\b${VERBO_RESTAURAR}\\b\\s+todo\\b`).test(msgSinTildes) ||
  new RegExp(
    `\\b${VERBO_RESTAURAR}\\b\\s+(?:todos?|todas?)\\s+(?:el\\s+|la\\s+|los\\s+|las\\s+)?(?:archivos?|ficheros?|papelera)\\b`,
  ).test(msgSinTildes);

// "vacía la papelera" / "borra (toda) la papelera" / "borra todo ... papelera"
// (operación masiva IRREVERSIBLE). Excluye "borra X de la papelera" (archivo
// concreto) y las menciones a facturas. `msg` en minúsculas y SIN tildes.
export const detectarVaciarPapelera = (msgSinTildes: string): boolean =>
  /\bpapelera\b/.test(msgSinTildes) &&
  !contieneFactura(msgSinTildes) &&
  (/\bvacia(?:r|la|las|lo|los|me|rla|rlas)?\b/.test(msgSinTildes) ||
    new RegExp(`\\b${VERBO_BORRAR}\\b\\s+(?:todo|toda|todos|todas)\\b`).test(msgSinTildes) ||
    new RegExp(`\\b${VERBO_BORRAR}\\b\\s+(?:la\\s+|toda\\s+la\\s+)?papelera\\b`).test(msgSinTildes));

// Clasifica un borrado MASIVO (a la papelera, reversible): "todo" (incluida la
// raíz), "carpetas" (solo carpetas + su contenido) o "archivos" (solo archivos).
// Devuelve null si no es un borrado masivo. `msg` en minúsculas y SIN tildes.
export type BorradoMasivo = "todo" | "carpetas" | "archivos" | null;
export const clasificarBorradoMasivo = (msgSinTildes: string): BorradoMasivo => {
  const esTodo =
    /borra(?:r|lo|la|los|las)?\s+todo\b|vacia(?:r|lo|la|los|las)?\s+todo\b|elimina(?:r|lo|la|los|las)?\s+todo\b|empeza(?:r)?\s+de\s+cero/.test(
      msgSinTildes,
    );
  if (esTodo) return "todo";
  const esSoloCarpetas =
    !/archivo|fichero/.test(msgSinTildes) &&
    /(borra(?:r|lo|la|los|las)?|vacia(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)\s+todas?\s+(las\s+)?carpetas?/.test(
      msgSinTildes,
    );
  if (esSoloCarpetas) return "carpetas";
  const esSoloArchivos =
    !/carpeta/.test(msgSinTildes) &&
    /(borra(?:r|lo|la|los|las)?|vacia(?:r|lo|la|los|las)?|elimina(?:r|lo|la|los|las)?|quita(?:r|lo|la|los|las)?)\s+todos?\s+(los\s+)?(archivos?|ficheros?)/.test(
      msgSinTildes,
    );
  if (esSoloArchivos) return "archivos";
  return null;
};

// Detecta un TRIMESTRE o SEMESTRE (fiscal) en el texto y lo convierte a un rango
// desde/hasta ISO. T1=ene-mar … T4=oct-dic; S1=ene-jun, S2=jul-dic. Cubre:
// ordinales ("primer/segundo/tercer/cuarto trimestre"), numéricos ("trimestre 3",
// "3er trimestre"), compactos ("T3", "Q1", "S2") y relativos ("este trimestre",
// "trimestre pasado/anterior"). `texto` llega en minúsculas y SIN tildes. `ahora`
// se inyecta para poder testear los relativos de forma determinista. Devuelve null
// si no hay trimestre/semestre (el caller sigue con el resto de detección de periodo).
export const detectarTrimestreSemestre = (
  texto: string,
  ahora: Date = new Date(),
): { desde: string; hasta: string; etiqueta: string } | null => {
  const anioTxt = texto.match(/\b(20\d{2})\b/);
  const rango = (n: number, semestre: boolean, anio: number) => {
    const mesIni = semestre ? (n - 1) * 6 + 1 : (n - 1) * 3 + 1;
    const mesFin = semestre ? mesIni + 5 : mesIni + 2;
    const ultimoDia = new Date(anio, mesFin, 0).getDate();
    return {
      desde: `${anio}-${String(mesIni).padStart(2, "0")}-01`,
      hasta: `${anio}-${String(mesFin).padStart(2, "0")}-${ultimoDia}`,
      etiqueta: `${n}º ${semestre ? "semestre" : "trimestre"} de ${anio}`,
    };
  };
  // Relativos (dependen de la fecha actual) antes que los explícitos.
  if (/\btrimestre\s+(pasado|anterior)\b/.test(texto) || /\b(el|del)\s+trimestre\s+anterior\b/.test(texto)) {
    const actual = Math.floor(ahora.getMonth() / 3) + 1;
    const n = actual === 1 ? 4 : actual - 1;
    const anio = actual === 1 ? ahora.getFullYear() - 1 : ahora.getFullYear();
    return rango(n, false, anio);
  }
  if (/\b(este|el)\s+trimestre\b/.test(texto) || /\btrimestre\s+actual\b/.test(texto)) {
    return rango(Math.floor(ahora.getMonth() / 3) + 1, false, ahora.getFullYear());
  }
  const anio = anioTxt ? Number(anioTxt[1]) : ahora.getFullYear();
  const ordinalDe = (s: string): number | null =>
    /\bprimer/.test(s) ? 1 : /\bsegundo/.test(s) ? 2 : /\btercer/.test(s) ? 3 : /\bcuarto/.test(s) ? 4 : null;
  if (/\bsemestre\b/.test(texto)) {
    let n = ordinalDe(texto);
    const num = texto.match(/semestre\s+([12])\b|\b([12])\s*(?:er|o|º|ª)?\s*semestre/);
    if (!n && num) n = Number(num[1] || num[2]);
    if (n === 1 || n === 2) return rango(n, true, anio);
  }
  if (/\btrimestre\b/.test(texto)) {
    let n = ordinalDe(texto);
    const num = texto.match(/trimestre\s+([1-4])\b|\b([1-4])\s*(?:er|o|º|ª)?\s*trimestre/);
    if (!n && num) n = Number(num[1] || num[2]);
    if (n && n >= 1 && n <= 4) return rango(n, false, anio);
  }
  const compactoTQ = texto.match(/\b[tq]\s*([1-4])\b/);
  if (compactoTQ) return rango(Number(compactoTQ[1]), false, anio);
  const compactoS = texto.match(/\bs\s*([12])\b/);
  if (compactoS) return rango(Number(compactoS[1]), true, anio);
  return null;
};
