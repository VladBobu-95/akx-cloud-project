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
