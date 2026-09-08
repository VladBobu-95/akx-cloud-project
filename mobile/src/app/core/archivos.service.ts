import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';

const TOKEN_KEY = 'akx_mobile_token';

export const atekaUrl = (): string => {
  if (Capacitor.getPlatform() === 'android') return 'http://10.0.2.2:3000';
  return 'http://localhost:3000';
};

export type Archivo = {
  id: string;
  nombre: string;
  carpeta: string;
  mimeType: string;
  tamanoBytes: string;
  subidoEn: string;
  actualizadoEn?: string;
  eliminadoEn?: string | null;
  estadoEscaneo?: string | null;
  estadoIndexado?: string | null;
};

export type CarpetaMeta = { ruta: string; creada?: string };

export type EspacioCompartido = {
  id: string;
  nombre: string;
  tamano?: number;
  actualizado?: string | null;
};

export type ResultadoBusqueda = {
  archivoId: string;
  nombre: string;
  carpeta: string;
  fragmento: string;
  score: number;
};

export type Visor = { url: string; mime: string; nombre: string; texto?: string };

const procesando = (a: Archivo): boolean =>
  a.estadoEscaneo === 'pendiente' ||
  a.estadoEscaneo === 'escaneando' ||
  a.estadoIndexado === 'pendiente' ||
  a.estadoIndexado === 'indexando';

@Injectable({ providedIn: 'root' })
export class ArchivosService {
  procesando = procesando;

  async authHeaders(): Promise<Record<string, string>> {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    return value ? { Authorization: `Bearer ${value}` } : {};
  }

  private async getJson<T>(path: string): Promise<{ data: T; headers: Record<string, string> }> {
    const headers = await this.authHeaders();
    const r = await CapacitorHttp.get({ url: `${atekaUrl()}${path}`, headers });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers || {})) h[k.toLowerCase()] = String(v);
    return { data: data as T, headers: h };
  }

  private async sendJson<T>(method: 'post' | 'patch' | 'delete', path: string, data?: unknown): Promise<T> {
    const headers = { ...(await this.authHeaders()), 'Content-Type': 'application/json' };
    const url = `${atekaUrl()}${path}`;
    const r =
      method === 'post'
        ? await CapacitorHttp.post({ url, headers, data })
        : method === 'patch'
          ? await CapacitorHttp.patch({ url, headers, data })
          : await CapacitorHttp.delete({ url, headers, data });
    const body = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((body && body.error) || `Error ${r.status}`);
    }
    return body as T;
  }

  private base(ccId: string | null): string {
    return ccId ? `/api/compartido/${ccId}` : '/api/archivos';
  }

  async listarTodos(ccId: string | null): Promise<Archivo[]> {
    if (ccId) {
      const { data } = await this.getJson<Archivo[]>(`${this.base(ccId)}/todos`);
      return Array.isArray(data) ? data : [];
    }
    const out: Archivo[] = [];
    let pagina = 1;
    let paginas = 1;
    do {
      const q = new URLSearchParams({ pagina: String(pagina), limite: '100' });
      const { data, headers } = await this.getJson<Archivo[]>(`/api/archivos?${q.toString()}`);
      const batch = Array.isArray(data) ? data : [];
      out.push(...batch);
      paginas = Math.max(1, Number(headers['x-total-pages'] || (batch.length < 100 ? pagina : pagina + 1)));
      pagina += 1;
    } while (pagina <= paginas && pagina <= 50);
    return out;
  }

  async listarCarpetas(ccId: string | null): Promise<CarpetaMeta[]> {
    const { data } = await this.getJson<CarpetaMeta[]>(`${this.base(ccId)}/carpetas`);
    return Array.isArray(data) ? data : [];
  }

  async espaciosCompartidos(): Promise<EspacioCompartido[]> {
    const { data } = await this.getJson<EspacioCompartido[]>('/api/compartido');
    return Array.isArray(data) ? data : [];
  }

  async crearCarpeta(ccId: string | null, ruta: string): Promise<void> {
    await this.sendJson('post', `${this.base(ccId)}/carpetas`, { ruta });
  }

  async reubicarCarpeta(ccId: string | null, origen: string, destino: string): Promise<void> {
    await this.sendJson('patch', `${this.base(ccId)}/carpetas`, { origen, destino });
  }

  async eliminarCarpeta(ccId: string | null, ruta: string): Promise<void> {
    const q = new URLSearchParams({ ruta });
    await this.sendJson('delete', `${this.base(ccId)}/carpetas?${q.toString()}`);
  }

  async subir(file: File, carpeta: string, ccId: string | null): Promise<void> {
    const headers = await this.authHeaders();
    const fd = new FormData();
    fd.append('archivo', file);
    if (carpeta) fd.append('carpeta', carpeta);
    const url = ccId ? `${atekaUrl()}/api/compartido/${ccId}/subir` : `${atekaUrl()}/api/archivos/subir`;
    const r = await fetch(url, { method: 'POST', headers, body: fd });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Error ${r.status}`);
    }
  }

  async actualizar(id: string, datos: { nombre?: string; carpeta?: string }, ccId: string | null): Promise<void> {
    const path = ccId ? `/api/compartido/archivo/${id}` : `/api/archivos/${id}`;
    const body: { nombre?: string; carpeta?: string } = { ...datos };
    if (datos.carpeta !== undefined) body.carpeta = rutaApi(datos.carpeta);
    await this.sendJson('patch', path, body);
  }

  async copiar(id: string, datos: { carpeta?: string; nombre?: string }, ccId: string | null): Promise<void> {
    const path = ccId ? `/api/compartido/archivo/${id}/copiar` : `/api/archivos/${id}/copiar`;
    const body: { nombre?: string; carpeta?: string } = { ...datos };
    if (datos.carpeta !== undefined) body.carpeta = rutaApi(datos.carpeta);
    await this.sendJson('post', path, body);
  }

  async eliminar(id: string, ccId: string | null): Promise<void> {
    const path = ccId ? `/api/compartido/archivo/${id}` : `/api/archivos/${id}`;
    await this.sendJson('delete', path);
  }

  async listarPapelera(): Promise<Archivo[]> {
    const { data } = await this.getJson<Archivo[]>('/api/archivos/papelera');
    return Array.isArray(data) ? data : [];
  }

  async restaurar(id: string): Promise<void> {
    await this.sendJson('patch', `/api/archivos/${id}/restaurar`, {});
  }

  async borrarPermanente(id: string): Promise<void> {
    await this.sendJson('delete', `/api/archivos/${id}/permanente`);
  }

  async vaciarPapelera(): Promise<{ borrados: number }> {
    const r = await this.sendJson<{ borrados?: number }>('delete', '/api/archivos/papelera');
    return { borrados: Number(r?.borrados) || 0 };
  }

  async buscar(q: string, ccId: string | null): Promise<ResultadoBusqueda[]> {
    const path = ccId
      ? `/api/compartido/${ccId}/buscar?q=${encodeURIComponent(q)}`
      : `/api/archivos/buscar?q=${encodeURIComponent(q)}`;
    const { data } = await this.getJson<ResultadoBusqueda[]>(path);
    return Array.isArray(data) ? data : [];
  }

  private urlDescarga(id: string, ccId: string | null): string {
    return ccId ? `${atekaUrl()}/api/compartido/archivo/${id}/descargar` : `${atekaUrl()}/api/archivos/${id}/descargar`;
  }

  async blobArchivo(id: string, ccId: string | null): Promise<Blob> {
    const headers = await this.authHeaders();
    const r = await fetch(this.urlDescarga(id, ccId), { headers });
    if (!r.ok) throw new Error('No se pudo abrir el archivo.');
    return r.blob();
  }

  async abrir(a: Archivo, ccId: string | null): Promise<Visor | void> {
    const blob = await this.blobArchivo(a.id, ccId);
    const mime = a.mimeType || blob.type || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      return { url: URL.createObjectURL(blob), mime, nombre: a.nombre };
    }
    if (mime.startsWith('text/') || mime === 'application/json') {
      return { url: '', mime, nombre: a.nombre, texto: await blob.text() };
    }
    await this.abrirNativo(blob, a.nombre, mime);
  }

  async descargar(a: Archivo, ccId: string | null): Promise<void> {
    const blob = await this.blobArchivo(a.id, ccId);
    const mime = a.mimeType || blob.type || 'application/octet-stream';
    await this.abrirNativo(blob, a.nombre, mime);
  }

  private async abrirNativo(blob: Blob, nombre: string, mime: string): Promise<void> {
    const data = await blobABase64(blob);
    const safe = nombre.replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_') || 'archivo';
    const path = `ateka-open-${Date.now()}-${safe}`;
    await Filesystem.writeFile({ path, data, directory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    if (Capacitor.getPlatform() === 'android') {
      await FileOpener.open({ filePath: uri, contentType: mime });
      return;
    }
    window.open(uri, '_blank');
  }
}

const blobABase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(blob);
  });


export const normalizarRuta = (ruta: string): string => (ruta ?? '').replace(/^\/+|\/+$/g, '');

export const rutaApi = (ruta: string): string => {
  const n = normalizarRuta(ruta);
  return n ? `/${n}` : '/';
};

export const padreDe = (ruta: string): string => {
  const r = normalizarRuta(ruta);
  const i = r.lastIndexOf('/');
  return i <= 0 ? '' : r.slice(0, i);
};

export const nombreHoja = (ruta: string): string => {
  const r = normalizarRuta(ruta);
  const i = r.lastIndexOf('/');
  return i < 0 ? r : r.slice(i + 1);
};

export const hijasDe = (todas: string[], actual: string): string[] => {
  const act = normalizarRuta(actual);
  return todas.filter((r) => padreDe(r) === act).sort((a, b) => nombreHoja(a).localeCompare(nombreHoja(b), 'es'));
};

export const unirRuta = (base: string, hoja: string): string => {
  const b = normalizarRuta(base);
  const h = normalizarRuta(hoja);
  return b ? `${b}/${h}` : h;
};

export const tamanoHumano = (bytes: string | number): string => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
