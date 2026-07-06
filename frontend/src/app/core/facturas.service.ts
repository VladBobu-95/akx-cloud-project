import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { FacturaDetalle, ListaFacturas, TipoFactura } from './models';

// Página de Facturas: listado paginado por tipo (venta/compra/sin clasificar) y
// edición manual de una factura escaneada (corregir lo que la IA sacó mal).
@Injectable({ providedIn: 'root' })
export class FacturasService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/facturas`;

  listar(opts: { tipo?: TipoFactura; pagina?: number; limite?: number } = {}): Observable<ListaFacturas> {
    let params = new HttpParams()
      .set('pagina', opts.pagina ?? 1)
      .set('limite', opts.limite ?? 20);
    if (opts.tipo) params = params.set('tipo', opts.tipo);
    return this.http.get<ListaFacturas>(this.base, { params });
  }

  obtener(id: string): Observable<FacturaDetalle> {
    return this.http.get<FacturaDetalle>(`${this.base}/${id}`);
  }

  actualizar(id: string, datos: Partial<FacturaDetalle>): Observable<FacturaDetalle> {
    return this.http.patch<FacturaDetalle>(`${this.base}/${id}`, datos);
  }
}
