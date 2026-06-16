import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface MensajeChat {
  rol: 'usuario' | 'bot';
  contenido: string;
}

// Mensaje tal y como lo muestra la UI.
export interface Mensaje {
  de: 'usuario' | 'bot';
  texto: string;
}

export interface RespuestaChat {
  respuesta: string;
  acciones: string[];
}

const CHAT_KEY = 'akx_chat';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/chat`;

  // El historial vive en el servicio (singleton), así sobrevive al cambiar de
  // página; además se persiste en localStorage para sobrevivir a recargas.
  readonly mensajes = signal<Mensaje[]>(this.cargar());

  añadir(m: Mensaje) {
    this.mensajes.update((arr) => [...arr, m]);
    this.persistir();
  }

  limpiar() {
    this.mensajes.set([]);
    this.persistir();
  }

  // Envía el historial de la conversación y devuelve la respuesta del asistente.
  enviar(mensajes: MensajeChat[]) {
    return this.http.post<RespuestaChat>(this.base, { mensajes });
  }

  private cargar(): Mensaje[] {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      return raw ? (JSON.parse(raw) as Mensaje[]) : [];
    } catch {
      return [];
    }
  }
  private persistir() {
    localStorage.setItem(CHAT_KEY, JSON.stringify(this.mensajes()));
  }
}
