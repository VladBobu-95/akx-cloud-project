import { Observable } from 'rxjs';
import { Archivo, ResultadoBusqueda } from '../../core/models';

// Abstracción de origen de datos del explorador. La implementan tanto
// `ArchivosService` (archivos personales) como el adaptador de carpetas
// compartidas (ver `compartido.ts`), de modo que UN mismo `ExploradorComponent`
// sirve a "Mis archivos" y a "Compartido" sin duplicar la lógica del explorador.
// Los métodos coinciden en nombre y firma con los de `ArchivosService` para que
// éste se pueda pasar tal cual como fuente personal.
export interface FuenteArchivos {
  listarTodos(): Observable<Archivo[]>;
  listarCarpetas(): Observable<{ ruta: string; creada: string }[]>;
  crearCarpetaApi(ruta: string): Observable<unknown>;
  reubicarCarpetaApi(origen: string, destino: string): Observable<unknown>;
  eliminarCarpetaApi(ruta: string, soloMeta?: boolean): Observable<unknown>;
  subir(file: File, carpeta?: string): Observable<Archivo>;
  descargar(id: string): Observable<Blob>;
  descargarCarpeta(ruta: string): Observable<Blob>;
  actualizar(id: string, datos: { nombre?: string; carpeta?: string }): Observable<unknown>;
  copiar(id: string, datos: { carpeta?: string; nombre?: string }): Observable<unknown>;
  eliminar(id: string): Observable<unknown>;
  describirArchivo(id: string, descripcion: string): Observable<unknown>;
  escanearFactura(id: string, pista?: string): Observable<unknown>;
  buscarSemantica(q: string): Observable<ResultadoBusqueda[]>;
}

// Opciones de comportamiento que difieren entre Personal y Compartido.
export interface OpcionesExplorador {
  // Etiqueta de la raíz en los listados de "Mover a…" ("Mis archivos" o el nombre
  // de la carpeta compartida).
  etiquetaRaiz: string;
  // Buscador semántico (RAG). Solo en personal (la búsqueda del chat es personal).
  soportaBusqueda: boolean;
  // Acciones de IA en el menú contextual: añadir descripción / escanear factura.
  soportaIA: boolean;
  // true → los borrados van a la papelera; false → borrado definitivo (compartido).
  aPapelera: boolean;
  // Muestra la columna "Estado" (progreso de escaneo/indexado). Por defecto true;
  // en compartido se pone false (los archivos se indexan solos y no se escanean a
  // analítica, así que ese estado no aporta al usuario).
  mostrarEstado?: boolean;
  // Etiqueta de la columna de fecha. Personal: "Subido" (por defecto); compartido:
  // "Última actualización".
  etiquetaFecha?: string;
  // Qué fecha del archivo muestra la columna: "subidoEn" (fecha de subida, por
  // defecto) o "actualizadoEn" (última modificación: renombrar/mover/copiar). En
  // compartido se usa "actualizadoEn". Afecta también a la fecha de las carpetas
  // (min de subida vs. max de última actualización de su contenido).
  campoFecha?: 'subidoEn' | 'actualizadoEn';
  // Si está presente, habilita mover/copiar hacia OTRO espacio (personal ↔ compartido):
  //  - marca el botón `[dropAttr]` como zona de drop del arrastre (el drag MUEVE);
  //  - añade los `destinos` a "Mover a…" (mueve) y a "Copiar en…" (copia).
  // `etiqueta` es el nombre del espacio para el "ghost" del arrastre. Cada destino
  // tiene un `id` (ccId al ir a compartido; null = Mis archivos) y opcionalmente sus
  // `carpetas` (subcarpetas donde también se puede soltar). Ausente en el caso sin
  // espacio externo.
  destinoExterno?: {
    etiqueta: string;
    dropAttr: string;
    destinos: { id: string | null; etiqueta: string; carpetas?: string[] }[];
  };
}

// Petición de mover/copiar que emite el explorador cuando el usuario lleva elementos a
// un destino EXTERNO (personal ↔ compartido). Ya trae calculadas las rutas destino
// (relativas a la raíz del destino) para cada archivo y las subcarpetas vacías, más el
// `destinoId` del espacio elegido (ccId, o null para Mis archivos).
export interface PeticionExportar {
  destinoId: string | null;
  archivos: { id: string; carpetaDestino: string }[];
  carpetasVacias: string[];
}
