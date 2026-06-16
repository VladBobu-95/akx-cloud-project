import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ChatService } from '../../core/chat.service';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-inicio',
  imports: [FormsModule],
  template: `
    <div class="head row">
      <div>
        <h1>Hola, {{ auth.usuario()?.nombre || auth.usuario()?.email }}</h1>
      </div>
      <span class="spacer"></span>
      @if (mensajes().length > 0) {
        <button class="btn btn-ghost btn-sm limpiar-btn" (click)="limpiar()">Limpiar conversación</button>
      }
    </div>

    <div class="card chat-card">
      <div class="mensajes">
        @if (mensajes().length === 0) {
          <div class="empty">
            <div class="icon">💬</div>
            Escribe un mensaje para empezar a chatear.
          </div>
        } @else {
          @for (m of mensajes(); track $index) {
            <div class="burbuja" [class.usuario]="m.de === 'usuario'" [class.bot]="m.de === 'bot'">
              {{ m.texto }}
            </div>
          }
          @if (pensando()) {
            <div class="burbuja bot pensando">Pensando…</div>
          }
        }
      </div>

      <form class="barra" (ngSubmit)="enviar()">
        <input
          class="input"
          type="text"
          name="entrada"
          [(ngModel)]="entrada"
          placeholder="Escribe tu mensaje…"
          autocomplete="off"
          [disabled]="pensando()"
        />
        <button class="btn btn-primary" type="submit" [disabled]="!entrada.trim() || pensando()">
          Enviar
        </button>
      </form>
    </div>
  `,
  styles: [
    `
      .head {
        margin-bottom: 18px;
      }
      /* Botón de limpiar: siempre rodeado por un borde tipo "burbuja";
         al pasar el ratón por encima se pone verde. */
      .limpiar-btn {
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 16px;      
        font-size: 1.3rem;
        margin-bottom: 1px;
        transition:
          background 0.15s ease,
          border-color 0.15s ease,
          color 0.15s ease;
      }
      .limpiar-btn:hover {
        background: var(--green);
        border-color: var(--green);
        color: #fff;
      }
      .chat-card {
        display: flex;
        flex-direction: column;
        height: 60vh;
        min-height: 380px;
        padding: 0;
        overflow: hidden;
      }
      .mensajes {
        flex: 1;
        overflow-y: auto;
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .empty {
        margin: auto;
        text-align: center;
        color: var(--muted);
      }
      .empty .icon {
        font-size: 2rem;
        margin-bottom: 6px;
      }
      .burbuja {
        max-width: 75%;
        padding: 10px 14px;
        border-radius: 14px;
        font-size: 0.92rem;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .burbuja.usuario {
        align-self: flex-end;
        background: var(--green);
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .burbuja.bot {
        align-self: flex-start;
        background: var(--surface);
        color: var(--text);
        border-bottom-left-radius: 4px;
      }
      .burbuja.pensando {
        opacity: 0.6;
        font-style: italic;
      }
      .barra {
        display: flex;
        gap: 8px;
        padding: 12px;
        border-top: 1px solid var(--border);
      }
      .barra .input {
        flex: 1;
      }
    `,
  ],
})
export class InicioPage {
  protected auth = inject(AuthService);
  private chat = inject(ChatService);

  // El historial vive en el servicio (persiste al cambiar de página y al recargar).
  protected mensajes = this.chat.mensajes;
  protected entrada = '';
  protected pensando = signal(false);

  limpiar() {
    this.chat.limpiar();
  }

  enviar() {
    const texto = this.entrada.trim();
    if (!texto || this.pensando()) return;

    this.chat.añadir({ de: 'usuario', texto });
    this.entrada = '';
    this.pensando.set(true);

    // Como contexto enviamos SOLO tus mensajes (no las respuestas del bot). Si
    // le reenviamos sus propias respuestas narradas ("he creado la carpeta..."),
    // el modelo aprende a fingir el éxito con texto en vez de llamar a la
    // herramienta, y falla a partir del 2º mensaje. El estado real (qué archivos
    // o carpetas hay) lo consulta siempre con las tools, así que no se pierde
    // nada importante. Limitamos a los últimos turnos para no inflar el contexto.
    const historial = this.mensajes()
      .filter((m) => m.de === 'usuario')
      .slice(-8)
      .map((m) => ({ rol: m.de, contenido: m.texto }));

    this.chat.enviar(historial).subscribe({
      next: (r) => {
        const extra = r.acciones?.length ? '\n\n' + r.acciones.map((a) => `✓ ${a}`).join('\n') : '';
        this.chat.añadir({ de: 'bot', texto: r.respuesta + extra });
        this.pensando.set(false);
      },
      error: (err) => {
        this.chat.añadir({ de: 'bot', texto: mensajeError(err) });
        this.pensando.set(false);
      },
    });
  }
}
