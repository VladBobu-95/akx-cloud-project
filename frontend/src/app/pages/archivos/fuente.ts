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
  eliminarCarpetaApi(ruta: string): Observable<unknown>;
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
}
