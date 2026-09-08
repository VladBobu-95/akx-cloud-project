import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { CapacitorHttp } from '@capacitor/core';
import { atekaUrl } from './archivos.service';

const TOKEN_KEY = 'akx_mobile_token';

export type TipoFactura = 'venta' | 'compra' | 'desconocido';

export type FilaFactura = {
  id: string;
  archivoId: string | null;
  archivoNombre: string | null;
  numero: string;
  fecha: string;
  emisor: string;
  cliente: string;
  tipo: TipoFactura;
  subtotal: number;
  iva: number;
  total: number;
  moneda: string;
};

export type LineaFactura = {
  descripcion: string;
  cantidad: number;
  precioUnit: number;
  total: number;
};

export type FacturaDetalle = {
  id: string;
  archivoId: string | null;
  archivoNombre: string | null;
  numero: string;
  fecha: string | null;
  emisor: string;
  emisorNif: string;
  cliente: string;
  clienteNif: string;
  tipo: TipoFactura;
  moneda: string;
  subtotal: number;
  iva: number;
  total: number;
  lineas: LineaFactura[];
};

export type ListaFacturas = {
  filas: FilaFactura[];
  total: number;
  paginas: number;
};

@Injectable({ providedIn: 'root' })
export class FacturasService {
  private async headers(): Promise<Record<string, string>> {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    return value ? { Authorization: `Bearer ${value}` } : {};
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await CapacitorHttp.get({ url: `${atekaUrl()}${path}`, headers: await this.headers() });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    return data as T;
  }

  private async sendJson<T>(method: 'post' | 'patch', path: string, data?: unknown): Promise<T> {
    const headers = { ...(await this.headers()), 'Content-Type': 'application/json' };
    const url = `${atekaUrl()}${path}`;
    const r =
      method === 'post'
        ? await CapacitorHttp.post({ url, headers, data })
        : await CapacitorHttp.patch({ url, headers, data });
    const body = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((body && body.error) || `Error ${r.status}`);
    }
    return body as T;
  }

  async listar(opts: { tipo?: TipoFactura; pagina?: number; limite?: number } = {}): Promise<ListaFacturas> {
    const q = new URLSearchParams({
      pagina: String(opts.pagina ?? 1),
      limite: String(opts.limite ?? 20),
    });
    if (opts.tipo) q.set('tipo', opts.tipo);
    const data = await this.getJson<ListaFacturas>(`/api/facturas?${q.toString()}`);
    return {
      filas: Array.isArray(data?.filas) ? data.filas : [],
      total: Number(data?.total) || 0,
      paginas: Math.max(1, Number(data?.paginas) || 1),
    };
  }

  async obtener(id: string): Promise<FacturaDetalle> {
    return this.getJson<FacturaDetalle>(`/api/facturas/${id}`);
  }

  async actualizar(id: string, datos: Partial<FacturaDetalle>): Promise<FacturaDetalle> {
    return this.sendJson('patch', `/api/facturas/${id}`, datos);
  }

  async reclasificar(): Promise<{ actualizadas: number; total: number }> {
    return this.sendJson('post', '/api/facturas/reclasificar', {});
  }
}
