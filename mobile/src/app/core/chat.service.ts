import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Preferences } from '@capacitor/preferences';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { atekaUrl } from './urls';

const TOKEN_KEY = 'akx_mobile_token';
const CHAT_KEY = 'akx_mobile_chat';
const CHAT_MS = 120_000;

// Resultado de la última consulta del asistente con varias filas (ver backend
// chat.service.ts). Las columnas "*_id" no se muestran.
export type TablaChat = {
  columnas: string[];
  filas: (string | number | boolean | null)[][];
  truncada: boolean;
};

export type Mensaje = {
  de: 'usuario' | 'bot';
  texto: string;
  tabla?: TablaChat;
};

type RespuestaChat = {
  respuesta: string;
  tabla?: TablaChat;
};

@Injectable({ providedIn: 'root' })
export class ChatService {
  mensajes: Mensaje[] = [];
  pensando = false;
  borrador = '';

  constructor(private http: HttpClient) {}

  async hidratar(): Promise<void> {
    const { value } = await Preferences.get({ key: CHAT_KEY });
    if (!value) {
      this.mensajes = [];
      return;
    }
    try {
      this.mensajes = JSON.parse(value) as Mensaje[];
    } catch {
      this.mensajes = [];
    }
  }

  async reset(): Promise<void> {
    this.pensando = false;
    this.borrador = '';
    this.mensajes = [];
    await Preferences.remove({ key: CHAT_KEY });
  }

  async enviarMensaje(texto: string): Promise<void> {
    const t = texto.trim();
    if (!t) return;
    this.mensajes = [...this.mensajes, { de: 'usuario', texto: t }];
    this.pensando = true;
    await this.persistir();
    try {
      // Contexto: los últimos mensajes de los dos lados (el chat es de solo
      // lectura, reenviar el historial no repite acciones).
      const historial = this.mensajes
        .slice(-8)
        .map((m) => ({ rol: m.de, contenido: m.texto }));
      const r = await this.postChat(historial);
      this.mensajes = [...this.mensajes, { de: 'bot', texto: r.respuesta || '', tabla: r.tabla }];
    } catch (err) {
      this.mensajes = [...this.mensajes, { de: 'bot', texto: this.mensajeError(err) }];
    } finally {
      this.pensando = false;
      await this.persistir();
    }
  }

  private async postChat(
    mensajes: { rol: 'usuario' | 'bot'; contenido: string }[],
  ): Promise<RespuestaChat> {
    const { value: token } = await Preferences.get({ key: TOKEN_KEY });
    const body = { mensajes };
    if (Capacitor.getPlatform() === 'android') {
      const r = await this.conTope(
        CapacitorHttp.post({
          url: `${atekaUrl()}/api/chat`,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          data: body,
        }),
        CHAT_MS,
      );
      const data = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : r.data || {};
      if (r.status < 200 || r.status >= 300) {
        throw new HttpErrorResponse({ status: r.status, error: data });
      }
      return data as RespuestaChat;
    }
     return firstValueFrom(
      this.http.post<RespuestaChat>(`${atekaUrl()}/api/chat`, body, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }).pipe(timeout(CHAT_MS)),
    );
  }

  private conTope<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => {
        setTimeout(() => rej(Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })), ms);
      }),
    ]);
  }

  private async persistir(): Promise<void> {
    await Preferences.set({ key: CHAT_KEY, value: JSON.stringify(this.mensajes) });
  }

  mensajeError(err: unknown): string {
    const nombre = err && typeof err === 'object' ? (err as { name?: string }).name : '';
    if (nombre === 'TimeoutError') return 'El asistente tardó demasiado.';
    const http = err as HttpErrorResponse;
    if (http.status === 403) {
      return (http.error && http.error.error) || 'El chat no está disponible para tu rol.';
    }
    if (http.status === 401) return 'Sesión caducada. Vuelve a entrar.';
    if (http.status === 0) return 'No hay conexión con ATEKA.';
    return (http.error && http.error.error) || 'No se pudo enviar el mensaje.';
  }
}
