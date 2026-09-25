import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { mensajeError } from '../shared/errores';

export interface MensajeChat {
  rol: 'usuario' | 'bot';
  contenido: string;
}

// Resultado de la última consulta del asistente con varias filas: se pinta como
// tabla debajo de la respuesta. Las columnas que acaban en "_id" no se muestran;
// si hay "archivo_id", cada fila lleva un botón "Abrir".
export type ValorTabla = string | number | boolean | null;
export interface TablaChat {
  columnas: string[];
  filas: ValorTabla[][];
  truncada: boolean;
  pagina?: number; // estado local de paginación (el backend manda todas las filas)
}

// Mensaje tal y como lo muestra la UI.
export interface Mensaje {
  de: 'usuario' | 'bot';
  texto: string;
  tabla?: TablaChat;
}

export interface RespuestaChat {
  respuesta: string;
  tabla?: TablaChat;
}

const CHAT_KEY = 'akx_chat';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/chat`;

  // El historial vive en el servicio (singleton), así sobrevive al cambiar de
  // página; además se persiste en localStorage para sobrevivir a recargas.
  readonly mensajes = signal<Mensaje[]>(this.cargar());

  // Texto que el usuario está escribiendo antes de enviar. Vive aquí (no en el
  // componente de la página) para que sobreviva al navegar a /archivos o
  // /papelera y volver, igual que el historial.
  readonly borrador = signal('');

  // `pensando` y la petición en curso viven en el servicio (no en InicioPage) para
  // que la IA NO deje de pensar al cambiar de pestaña (Mis archivos, Papelera,
  // Equipo…): el componente se destruye pero la petición y el estado siguen aquí,
  // y la respuesta se añade al historial aunque la página de chat no esté montada.
  readonly pensando = signal(false);
  private enCurso: Subscription | null = null;

  añadir(m: Mensaje) {
    this.mensajes.update((arr) => [...arr, m]);
    this.persistir();
  }

  // Reemplaza el mensaje en la posición dada (lo usa la paginación de la tabla
  // de un mensaje ya pintado) y persiste.
  actualizarMensaje(index: number, m: Mensaje) {
    this.mensajes.update((arr) => arr.map((x, i) => (i === index ? m : x)));
    this.persistir();
  }

  limpiar() {
    this.mensajes.set([]);
    this.persistir();
  }

  // Borra TODO el estado del chat: el historial y el borrador en memoria (este
  // servicio es un singleton que sobrevive al logout porque la SPA no recarga) y
  // también lo persistido en localStorage. Lo llama AuthService al cerrar sesión
  // y al iniciar una nueva, para que el chat de un usuario no se filtre al
  // siguiente que use el mismo navegador.
  reset() {
    this.cancelar();
    this.mensajes.set([]);
    this.borrador.set('');
    localStorage.removeItem(CHAT_KEY);
  }

  // Cancela la respuesta en curso (si la hay) sin dejar rastro y apaga "pensando".
  cancelar() {
    this.enCurso?.unsubscribe();
    this.enCurso = null;
    this.pensando.set(false);
  }

  // Punto de entrada del chat: añade el mensaje del usuario, gestiona "pensando" y
  // la petición, y añade la respuesta del bot al historial. Todo el ciclo vive
  // aquí para que:
  //  - la IA siga pensando aunque cambies de pestaña (el estado no es del componente),
  //  - puedas mandar otro mensaje mientras piensa: se cancela la respuesta en curso
  //    (se descarta sin rastro) y se atiende el nuevo request de inmediato.
  enviarMensaje(texto: string) {
    const t = texto.trim();
    if (!t) return;
    // Si había una respuesta en curso, la abandonamos y arrancamos la nueva.
    this.enCurso?.unsubscribe();

    this.añadir({ de: 'usuario', texto: t });
    this.pensando.set(true);

    // Contexto: los últimos mensajes de la conversación (de los dos lados), para
    // que el asistente entienda preguntas de seguimiento ("¿y en mayo?"). El chat
    // es de solo lectura, así que reenviar el historial no puede repetir acciones.
    const historial = this.mensajes()
      .slice(-8)
      .map((m) => ({ rol: m.de, contenido: m.texto }));

    this.enCurso = this.enviar(historial).subscribe({
      next: (r) => {
        this.añadir({ de: 'bot', texto: r.respuesta, tabla: r.tabla });
        this.pensando.set(false);
        this.enCurso = null;
      },
      error: (err) => {
        this.añadir({ de: 'bot', texto: mensajeError(err) });
        this.pensando.set(false);
        this.enCurso = null;
      },
    });
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
