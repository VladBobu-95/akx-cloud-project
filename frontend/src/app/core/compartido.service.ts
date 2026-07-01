import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Archivo, CarpetaCompartida } from './models';

// Carpetas compartidas por rol (Fase 3). Gestión (admin) + uso (miembros con acceso).
@Injectable({ providedIn: 'root' })
export class CompartidoService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/compartido`;

  // --- Miembro: uso ---
  accesibles(): Observable<{ id: string; nombre: string }[]> {
    return this.http.get<{ id: string; nombre: string }[]>(this.base);
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
}
