import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { AuthService } from '../../core/auth.service';
import { ChatService } from '../../core/chat.service';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
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
      <div class="mensajes" #mensajesContainer>
        @if (mensajes().length === 0) {
          <div class="empty">
            <div class="icon">💬</div>
            Escribe un mensaje para empezar a chatear.
          </div>
        } @else {
          @for (m of mensajes(); track $index) {
            <div class="burbuja" [class.usuario]="m.de === 'usuario'" [class.bot]="m.de === 'bot'">
              @if (m.de === 'bot') {
                <div class="md" [innerHTML]="renderBot(m.texto)"></div>
              } @else {
                {{ m.texto }}
              }
              @if (m.archivo) {
                <div class="abrir-archivo">
                  <button class="btn btn-outline btn-sm" (click)="abrirArchivo(m.archivo)">
                    📂 Abrir {{ m.archivo.nombre }}
                  </button>
                </div>
              }
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
          [ngModel]="chat.borrador()"
          (ngModelChange)="chat.borrador.set($event)"
          placeholder="Escribe tu mensaje…"
          autocomplete="off"
          [disabled]="pensando()"
        />
        <button class="btn btn-primary" type="submit" [disabled]="!chat.borrador().trim() || pensando()">
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
        word-break: break-word;
      }
      .burbuja.usuario {
        align-self: flex-end;
        background: var(--green);
        color: #fff;
        border-bottom-right-radius: 4px;
        white-space: pre-wrap;
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
      /* Markdown de las respuestas del bot (tablas de facturas/estadísticas,
         títulos ##, listas...). Reutiliza la misma idea que el visor de .md del
         explorador, pero más compacto para encajar en una burbuja de chat. */
      .burbuja.bot .md {
        overflow-x: auto;
      }
      .burbuja.bot .md > :first-child {
        margin-top: 0;
      }
      .burbuja.bot .md > :last-child {
        margin-bottom: 0;
      }
      .burbuja.bot .md p {
        margin: 0 0 8px;
      }
      .burbuja.bot .md h1,
      .burbuja.bot .md h2,
      .burbuja.bot .md h3 {
        font-size: 0.98rem;
        margin: 10px 0 6px;
      }
      .burbuja.bot .md ul,
      .burbuja.bot .md ol {
        margin: 0 0 8px;
        padding-left: 20px;
      }
      .burbuja.bot .md table {
        width: 100%;
        border-collapse: collapse;
        margin: 6px 0 10px;
        font-size: 0.85rem;
      }
      .burbuja.bot .md th,
      .burbuja.bot .md td {
        border: 1px solid var(--border);
        padding: 5px 8px;
        text-align: left;
        white-space: nowrap;
      }
      .burbuja.bot .md th {
        background: rgba(0, 0, 0, 0.04);
        font-weight: 700;
      }
      .burbuja.bot .md code {
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 0.85em;
      }
      .abrir-archivo {
        margin-top: 8px;
      }
      .abrir-archivo .btn {
        font-size: 0.85rem;
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
  protected chat = inject(ChatService);
  private archivosSvc = inject(ArchivosService);
  private toast = inject(ToastService);

  // El historial y el borrador viven en el servicio (persisten al cambiar de
  // página; el historial sobrevive también a recargar).
  protected mensajes = this.chat.mensajes;
  protected pensando = signal(false);

  private mensajesEl = viewChild<ElementRef<HTMLDivElement>>('mensajesContainer');

  // Renderiza la respuesta del bot como markdown (tablas de facturas/estadísticas,
  // títulos, listas...) en vez de texto plano. `breaks: true` para que un solo
  // salto de línea (ej. entre las líneas "✓ ..." de las acciones) se respete como
  // tal, en vez de fundirse en un único párrafo (comportamiento normal de
  // markdown, pero no el esperado en un chat). Angular sanitiza el HTML del
  // binding [innerHTML] automáticamente.
  protected renderBot(texto: string): string {
    return marked.parse(texto, { breaks: true, async: false });
  }

  // Se llama tras cada cambio en la lista de mensajes (usuario, bot, "pensando…")
  // para que la vista siga la conversación en vez de quedarse arriba. setTimeout(0)
  // espera a que Angular pinte el DOM con el mensaje nuevo antes de medir scrollHeight.
  private scrollAbajo() {
    setTimeout(() => {
      const el = this.mensajesEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  limpiar() {
    this.chat.limpiar();
  }

  enviar() {
    const texto = this.chat.borrador().trim();
    if (!texto || this.pensando()) return;

    this.chat.añadir({ de: 'usuario', texto });
    this.scrollAbajo();
    this.chat.borrador.set('');
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
        this.chat.añadir({ de: 'bot', texto: r.respuesta + extra, archivo: r.archivo });
        this.pensando.set(false);
        this.scrollAbajo();
      },
      error: (err) => {
        this.chat.añadir({ de: 'bot', texto: mensajeError(err) });
        this.pensando.set(false);
        this.scrollAbajo();
      },
    });
  }

  // Abre el archivo igual que en el explorador: PDF/imagen/texto en una pestaña
  // nueva, el resto se descarga. La ventana se abre en blanco YA (en el gesto
  // del clic) para que el navegador no la bloquee como pop-up, y se rellena
  // cuando llega el blob.
  abrirArchivo(archivo: { id: string; nombre: string }) {
    const win = window.open('', '_blank');
    this.archivosSvc.obtener(archivo.id).subscribe({
      next: (a) => {
        const previsualizable = /^(application\/pdf|image\/|text\/)/.test(a.mimeType ?? '');
        if (!previsualizable) {
          win?.close();
          this.archivosSvc.descargar(a.id).subscribe({
            next: (blob) => {
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = a.nombre;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            },
            error: (err) => this.toast.error(mensajeError(err)),
          });
          return;
        }
        this.archivosSvc.descargar(a.id).subscribe({
          next: (blob) => {
            const url = URL.createObjectURL(blob);
            if (win) {
              const esc = (s: string) =>
                s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const esImagen = /^image\//.test(a.mimeType);
              const cuerpo = esImagen ? `<img src="${url}">` : `<iframe src="${url}"></iframe>`;
              const estilos = esImagen
                ? `body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;}img{max-width:100%;max-height:100vh;object-fit:contain;}`
                : `html,body{height:100%;margin:0;padding:0;overflow:hidden;}iframe{width:100%;height:100%;border:none;}`;
              win.document.write(
                `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(a.nombre)}</title>` +
                  `<style>${estilos}</style></head><body>${cuerpo}</body></html>`,
              );
              win.document.close();
            } else {
              window.open(url, '_blank');
            }
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          },
          error: (err) => {
            win?.close();
            this.toast.error(mensajeError(err));
          },
        });
      },
      error: (err) => {
        win?.close();
        this.toast.error(mensajeError(err));
      },
    });
  }
}
