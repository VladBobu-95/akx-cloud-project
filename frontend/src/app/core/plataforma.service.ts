import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Empresa, Usuario } from './models';

// Panel de plataforma (solo superadmin): alta y gestión de empresas cliente.
@Injectable({ providedIn: 'root' })
export class PlataformaService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/plataforma`;

  listarEmpresas(): Observable<Empresa[]> {
    return this.http.get<Empresa[]>(`${this.base}/empresas`);
  }

  crearEmpresa(datos: {
    nombre: string;
    nif?: string;
    admin: { email: string; password: string; nombre: string };
  }): Observable<{ empresa: Empresa; admin: Usuario }> {
    return this.http.post<{ empresa: Empresa; admin: Usuario }>(
      `${this.base}/empresas`,
      datos,
    );
  }

  actualizarEmpresa(
    id: string,
    datos: { nombre?: string; nif?: string; estado?: 'activa' | 'suspendida' },
  ): Observable<Empresa> {
    return this.http.patch<Empresa>(`${this.base}/empresas/${id}`, datos);
  }

  eliminarEmpresa(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/empresas/${id}`);
  }
}
