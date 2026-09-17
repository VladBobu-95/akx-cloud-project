import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ClaveApi {
  id: string;
  nombre: string;
  prefijo: string;
  ultimoUso: string | null;
  creadoEn: string;
}

export interface ClaveApiNueva extends ClaveApi {
  clave: string;
}

@Injectable({ providedIn: 'root' })
export class ClavesService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/claves`;

  listar(): Observable<ClaveApi[]> {
    return this.http.get<ClaveApi[]>(this.base);
  }

  crear(nombre?: string): Observable<ClaveApiNueva> {
    return this.http.post<ClaveApiNueva>(this.base, nombre ? { nombre } : {});
  }

  revocar(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }
}
