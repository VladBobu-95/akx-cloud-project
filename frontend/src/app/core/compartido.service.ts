import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Archivo, CarpetaCompartida, ResultadoBusqueda } from './models';

// Carpeta compartida accesible + resumen para el listado (tamaño y última actualización).
export interface CarpetaCompartidaAccesible {
  id: string;
  nombre: string;
  tamano: number;
  actualizado: string | null;
}

// Un evento del registro de actividad de una carpeta compartida.
export interface EventoCompartido {
  id: string;
  usuarioNombre: string;
  accion:
    | 'subir'
    | 'descargar'
    | 'renombrar'
    | 'mover'
    | 'copiar'
    | 'eliminar'
    | 'copia_personal'
    | 'crear_carpeta'
    | 'borrar_carpeta'
    | 'mover_carpeta';
  objeto: string | null;
  ruta: string | null;
  detalle: string | null;
  creadoEn: string;
}

export interface PaginaEventos {
  eventos: EventoCompartido[];
  total: number;
  paginas: number;
}

// Carpetas compartidas por rol (Fase 3). Gestión (admin) + uso (miembros con acceso).
@Injectable({ providedIn: 'root' })
export class CompartidoService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/compartido`;

  // --- Miembro: uso ---
  // `tamano` = suma de bytes de sus archivos; `actualizado` = subida más reciente
  // (ISO) o null si está vacía. Para las columnas del listado de "Compartido".
  accesibles(): Observable<CarpetaCompartidaAccesible[]> {
    return this.http.get<CarpetaCompartidaAccesible[]>(this.base);
  }

  listarArchivos(
    carpetaCompartidaId: string,
    carpeta?: string,
  ): Observable<{ archivos: Archivo[]; subcarpetas: string[] }> {
    let params = new HttpParams();
    if (carpeta) params = params.set('carpeta', carpeta);
    return this.http.get<{ archivos: Archivo[]; subcarpetas: string[] }>(
      `${this.base}/${carpetaCompartidaId}/archivos`,
      { params },
    );
  }

  subir(carpetaCompartidaId: string, file: File, carpeta?: string): Observable<Archivo> {
    const fd = new FormData();
    fd.append('archivo', file);
    if (carpeta) fd.append('carpeta', carpeta);
    return this.http.post<Archivo>(`${this.base}/${carpetaCompartidaId}/subir`, fd);
  }

  descargar(archivoId: string): Observable<Blob> {
    return this.http.get(`${this.base}/archivo/${archivoId}/descargar`, { responseType: 'blob' });
  }

  eliminarArchivo(archivoId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/archivo/${archivoId}`);
  }

  // --- Explorador completo (paridad con "Mis archivos") ---
  // Todos los archivos de la carpeta compartida (para construir el árbol en cliente).
  listarTodos(carpetaCompartidaId: string): Observable<Archivo[]> {
    return this.http.get<Archivo[]>(`${this.base}/${carpetaCompartidaId}/todos`);
  }

  // Búsqueda semántica acotada a esta carpeta compartida (solo su contenido).
  buscarSemantica(carpetaCompartidaId: string, q: string): Observable<ResultadoBusqueda[]> {
    return this.http.get<ResultadoBusqueda[]>(`${this.base}/${carpetaCompartidaId}/buscar`, {
      params: new HttpParams().set('q', q),
    });
  }

  listarCarpetas(carpetaCompartidaId: string): Observable<{ ruta: string; creada: string }[]> {
    return this.http.get<{ ruta: string; creada: string }[]>(
      `${this.base}/${carpetaCompartidaId}/carpetas`,
    );
  }

  crearCarpeta(carpetaCompartidaId: string, ruta: string): Observable<{ ruta: string }> {
    return this.http.post<{ ruta: string }>(`${this.base}/${carpetaCompartidaId}/carpetas`, { ruta });
  }

  reubicarCarpeta(
    carpetaCompartidaId: string,
    origen: string,
    destino: string,
  ): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/${carpetaCompartidaId}/carpetas`, {
      origen,
      destino,
    });
  }

  eliminarCarpeta(carpetaCompartidaId: string, ruta: string): Observable<unknown> {
    return this.http.delete(`${this.base}/${carpetaCompartidaId}/carpetas`, {
      params: new HttpParams().set('ruta', ruta),
    });
  }

  descargarCarpeta(carpetaCompartidaId: string, ruta: string): Observable<Blob> {
    return this.http.get(`${this.base}/${carpetaCompartidaId}/carpeta/descargar`, {
      params: new HttpParams().set('ruta', ruta),
      responseType: 'blob',
    });
  }

  actualizarArchivo(
    archivoId: string,
    datos: { nombre?: string; carpeta?: string },
  ): Observable<Archivo> {
    return this.http.patch<Archivo>(`${this.base}/archivo/${archivoId}`, datos);
  }

  copiarArchivo(
    archivoId: string,
    datos: { carpeta?: string; nombre?: string },
  ): Observable<Archivo> {
    return this.http.post<Archivo>(`${this.base}/archivo/${archivoId}/copiar`, datos);
  }

  // Copia un archivo compartido al espacio PERSONAL del usuario (el original sigue en
  // compartido). `duplicado=true` → ya tenías ese contenido en personal (dedup por hash).
  copiarAPersonal(
    archivoId: string,
    carpetaDestino: string,
  ): Observable<Archivo & { duplicado?: boolean }> {
    return this.http.post<Archivo & { duplicado?: boolean }>(
      `${this.base}/archivo/${archivoId}/copiar-a-personal`,
      { carpeta: carpetaDestino },
    );
  }

  // MUEVE un archivo compartido al espacio PERSONAL (desaparece del compartido para
  // todos los del rol). `duplicado=true` → ya lo tenías en personal (dedup por hash).
  moverAPersonal(
    archivoId: string,
    carpetaDestino: string,
  ): Observable<Archivo & { duplicado?: boolean }> {
    return this.http.post<Archivo & { duplicado?: boolean }>(
      `${this.base}/archivo/${archivoId}/mover-a-personal`,
      { carpeta: carpetaDestino },
    );
  }

  // MUEVE un archivo PERSONAL a una carpeta compartida (deja de ser personal).
  moverDesdePersonal(
    carpetaCompartidaId: string,
    archivoId: string,
    carpetaDestino: string,
  ): Observable<Archivo & { duplicado?: boolean }> {
    return this.http.post<Archivo & { duplicado?: boolean }>(
      `${this.base}/${carpetaCompartidaId}/mover-desde-personal`,
      { archivoId, carpeta: carpetaDestino },
    );
  }

  // COPIA un archivo PERSONAL a una carpeta compartida (el original permanece).
  copiarDesdePersonal(
    carpetaCompartidaId: string,
    archivoId: string,
    carpetaDestino: string,
  ): Observable<Archivo & { duplicado?: boolean }> {
    return this.http.post<Archivo & { duplicado?: boolean }>(
      `${this.base}/${carpetaCompartidaId}/copiar-desde-personal`,
      { archivoId, carpeta: carpetaDestino },
    );
  }

  // --- Admin: gestión ---
  listarAdmin(): Observable<CarpetaCompartida[]> {
    return this.http.get<CarpetaCompartida[]>(`${this.base}/admin`);
  }

  crear(datos: { nombre: string; rolesIds: string[] }): Observable<CarpetaCompartida> {
    return this.http.post<CarpetaCompartida>(`${this.base}/admin`, datos);
  }

  actualizar(
    id: string,
    datos: { nombre?: string; rolesIds?: string[] },
  ): Observable<CarpetaCompartida> {
    return this.http.patch<CarpetaCompartida>(`${this.base}/admin/${id}`, datos);
  }

  eliminar(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/${id}`);
  }

  // Registro de actividad de una carpeta compartida (admin), paginado.
  logs(id: string, pagina = 1, limite = 20): Observable<PaginaEventos> {
    const params = new HttpParams()
      .set('pagina', String(pagina))
      .set('limite', String(limite));
    return this.http.get<PaginaEventos>(`${this.base}/admin/${id}/logs`, { params });
  }
}
