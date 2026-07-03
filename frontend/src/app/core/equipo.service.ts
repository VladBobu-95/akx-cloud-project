import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Archivo, Miembro, Rol } from './models';

// Equipo de la empresa (solo admin): miembros, roles configurables y archivos
// de cada miembro.
@Injectable({ providedIn: 'root' })
export class EquipoService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/equipo`;

  // --- Capacidades (vocabulario fijo) ---
  listarCapacidades(): Observable<string[]> {
    return this.http.get<string[]>(`${this.base}/capacidades`);
  }

  // --- Empresa propia (nombre + CIF) ---
  obtenerEmpresa(): Observable<{ id: string; nombre: string; nif: string | null }> {
    return this.http.get<{ id: string; nombre: string; nif: string | null }>(`${this.base}/empresa`);
  }

  actualizarEmpresa(datos: { nif?: string }): Observable<{ id: string; nombre: string; nif: string | null }> {
    return this.http.patch<{ id: string; nombre: string; nif: string | null }>(`${this.base}/empresa`, datos);
  }

  // --- Miembros ---
  listarMiembros(): Observable<Miembro[]> {
    return this.http.get<Miembro[]>(`${this.base}/usuarios`);
  }

  crearMiembro(datos: {
    nombre: string;
    email: string;
    password: string;
    rol: 'miembro' | 'admin';
    rolesIds: string[];
  }): Observable<Miembro> {
    return this.http.post<Miembro>(`${this.base}/usuarios`, datos);
  }

  actualizarMiembro(
    id: string,
    datos: {
      nombre?: string;
      email?: string;
      password?: string;
      rol?: 'miembro' | 'admin';
      rolesIds?: string[];
    },
  ): Observable<Miembro> {
    return this.http.patch<Miembro>(`${this.base}/usuarios/${id}`, datos);
  }

  eliminarMiembro(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/usuarios/${id}`);
  }

  archivosDeMiembro(
    id: string,
    carpeta?: string,
    pagina = 1,
    limite = 100,
  ): Observable<{ archivos: Archivo[]; total: number; paginas: number }> {
    let params = new HttpParams().set('pagina', pagina).set('limite', limite);
    if (carpeta) params = params.set('carpeta', carpeta);
    return this.http.get<{ archivos: Archivo[]; total: number; paginas: number }>(
      `${this.base}/usuarios/${id}/archivos`,
      { params },
    );
  }

  // --- Roles ---
  listarRoles(): Observable<Rol[]> {
    return this.http.get<Rol[]>(`${this.base}/roles`);
  }

  crearRol(datos: { nombre: string; capacidades: string[] }): Observable<Rol> {
    return this.http.post<Rol>(`${this.base}/roles`, datos);
  }

  actualizarRol(
    id: string,
    datos: { nombre?: string; capacidades?: string[] },
  ): Observable<Rol> {
    return this.http.patch<Rol>(`${this.base}/roles/${id}`, datos);
  }

  eliminarRol(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/roles/${id}`);
  }
}
