import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, of, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Archivo, ListaArchivos, ResultadoBusqueda } from './models';

@Injectable({ providedIn: 'root' })
export class ArchivosService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/archivos`;

  // Listar con paginacion. El backend devuelve el array en el body y los totales
  // en cabeceras (X-Total-*), por eso usamos observe: 'response'.
  listar(carpeta?: string, pagina = 1, limite = 20) {
    let params = new HttpParams()
      .set('pagina', pagina)
      .set('limite', limite);
    if (carpeta) params = params.set('carpeta', carpeta);

    return this.http
      .get<Archivo[]>(this.base, { params, observe: 'response' })
      .pipe(
        map(
          (res): ListaArchivos => ({
            archivos: res.body ?? [],
            total: Number(res.headers.get('X-Total-Count') ?? 0),
            paginas: Number(res.headers.get('X-Total-Pages') ?? 0),
            pagina: Number(res.headers.get('X-Current-Page') ?? pagina),
          }),
        ),
      );
  }

  // Trae TODOS los archivos activos del usuario recorriendo las páginas
  // (limite máximo del backend = 100). Sirve para construir el árbol de carpetas
  // en el cliente, ya que el backend filtra por carpeta exacta (no por prefijo).
  listarTodos(): Observable<Archivo[]> {
    const pedir = (pagina: number): Observable<Archivo[]> =>
      this.listar(undefined, pagina, 100).pipe(
        switchMap((r) =>
          r.paginas <= pagina
            ? of(r.archivos)
            : pedir(pagina + 1).pipe(map((resto) => [...r.archivos, ...resto])),
        ),
      );
    return pedir(1);
  }

  // Duplica un archivo (binario incluido) en la carpeta destino indicada.
  copiar(id: string, datos: { carpeta?: string; nombre?: string }) {
    return this.http.post<Archivo>(`${this.base}/${id}/copiar`, datos);
  }

  // Descarga una carpeta y todo su contenido como un único .zip (lo genera el
  // backend conservando las subcarpetas).
  descargarCarpeta(ruta: string) {
    const params = new HttpParams().set('ruta', ruta);
    return this.http.get(`${this.base}/carpeta/descargar`, { params, responseType: 'blob' });
  }

  // --- Carpetas (metadata persistida en el backend) ---
  listarCarpetas() {
    return this.http.get<{ ruta: string; creada: string }[]>(`${this.base}/carpetas`);
  }
  crearCarpetaApi(ruta: string) {
    return this.http.post<{ ruta: string }>(`${this.base}/carpetas`, { ruta });
  }
  reubicarCarpetaApi(origen: string, destino: string) {
    return this.http.patch<{ ok: boolean }>(`${this.base}/carpetas`, { origen, destino });
  }
  eliminarCarpetaApi(ruta: string) {
    return this.http.delete(`${this.base}/carpetas`, { params: new HttpParams().set('ruta', ruta) });
  }

  // Búsqueda semántica (RAG) por el contenido de los documentos.
  buscarSemantica(q: string) {
    const params = new HttpParams().set('q', q);
    return this.http.get<ResultadoBusqueda[]>(`${this.base}/buscar`, { params });
  }

  // Guarda una descripción manual de un archivo (típicamente una imagen) para
  // poder encontrarlo luego por su contenido en el buscador semántico.
  describirArchivo(archivoId: string, descripcion: string) {
    return this.http.patch<{ mensaje: string }>(
      `${this.base}/${archivoId}/descripcion`,
      { descripcion },
    );
  }

  // Lanza el escaneo manual de factura sobre un archivo ya subido. Es
  // asíncrono (202): el resultado se ve vía polling de "estadoEscaneo".
  escanearFactura(archivoId: string, pista?: string) {
    return this.http.post<{ estado: string }>(
      `${environment.apiUrl}/api/facturas/escanear`,
      { archivoId, pista },
    );
  }

  subir(file: File, carpeta?: string) {
    const fd = new FormData();
    fd.append('archivo', file);
    if (carpeta) fd.append('carpeta', carpeta);
    return this.http.post<Archivo>(`${this.base}/subir`, fd);
  }

  actualizar(id: string, datos: { nombre?: string; carpeta?: string }) {
    return this.http.patch<Archivo>(`${this.base}/${id}`, datos);
  }

  eliminar(id: string) {
    return this.http.delete(`${this.base}/${id}`);
  }

  restaurar(id: string) {
    return this.http.patch<{ mensaje: string }>(`${this.base}/${id}/restaurar`, {});
  }

  borrarPermanente(id: string) {
    return this.http.delete(`${this.base}/${id}/permanente`);
  }

  listarPapelera() {
    return this.http.get<Archivo[]>(`${this.base}/papelera`);
  }

  vaciarPapelera() {
    return this.http.delete<{ mensaje: string; borrados: number }>(
      `${this.base}/papelera`,
    );
  }

  // Descarga: el endpoint responde 302 a una URL firmada de MinIO; el navegador la
  // sigue y devolvemos el blob para forzar la descarga con el nombre original.
  descargar(id: string) {
    return this.http.get(`${this.base}/${id}/descargar`, { responseType: 'blob' });
  }

  // Metadatos de un archivo (nombre, mimeType...), sin descargar el binario.
  obtener(id: string) {
    return this.http.get<Archivo>(`${this.base}/${id}`);
  }
}
