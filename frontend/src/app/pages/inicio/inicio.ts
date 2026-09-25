import { AfterViewInit, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { AuthService } from '../../core/auth.service';
import { ChatService, TablaChat, ValorTabla } from '../../core/chat.service';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-inicio',
  imports: [FormsModule],
  templateUrl: './inicio.html',
  styleUrl: './inicio.scss',
})
export class InicioPage implements AfterViewInit {
  protected auth = inject(AuthService);
  protected chat = inject(ChatService);
  private archivosSvc = inject(ArchivosService);
  private toast = inject(ToastService);

  // El historial, el borrador y el estado "pensando" viven en el servicio
  // (persisten al cambiar de página; el historial sobrevive también a recargar).
  // Que "pensando" y la petición vivan en el servicio es lo que hace que la IA no
  // deje de pensar al cambiar de pestaña.
  protected mensajes = this.chat.mensajes;
  protected pensando = this.chat.pensando;

  private mensajesEl = viewChild<ElementRef<HTMLDivElement>>('mensajesContainer');
  private inputChat = viewChild<ElementRef<HTMLInputElement>>('inputChat');

  constructor() {
    // Sigue la conversación hacia abajo cuando cambia (mensaje nuevo del usuario,
    // del bot, o al montar el componente con el historial ya cargado). Cubre
    // también las respuestas que llegan mientras estabas en otra pestaña.
    effect(() => {
      this.mensajes();
      this.scrollAbajo();
    });
  }

  // Al volver a esta página (Angular recrea el componente), la conversación ya
  // tiene mensajes guardados pero la vista arranca con scroll en 0 — sin esto
  // se queda arriba en vez de mostrar los últimos mensajes.
  ngAfterViewInit() {
    this.scrollAbajo();
  }

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
    // No bloqueamos por `pensando`: se permite mandar otro mensaje mientras la IA
    // piensa; el servicio cancela la respuesta en curso y atiende el nuevo.
    if (!texto) return;
    this.chat.borrador.set('');
    this.enviarTexto(texto);
  }

  // Delega en el servicio, que gestiona "pensando", la cancelación de la respuesta
  // en curso y añadir la respuesta al historial (sobrevive al cambio de pestaña).
  private enviarTexto(texto: string) {
    if (!texto) return;
    this.chat.enviarMensaje(texto);
    setTimeout(() => this.inputChat()?.nativeElement.focus(), 0);
  }

  // --- Tabla de resultados del asistente ---
  // El backend manda todas las filas (máx. 200); se paginan en memoria.
  private readonly FILAS_POR_PAGINA = 10;

  // Columnas visibles: los identificadores ("*_id") no se enseñan.
  protected columnasVisibles(t: TablaChat): { nombre: string; i: number }[] {
    return t.columnas
      .map((c, i) => ({ nombre: c, i }))
      .filter(({ nombre }) => !nombre.endsWith('_id'));
  }

  protected titulo(columna: string): string {
    const t = columna.replace(/_/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  protected totalPaginas(t: TablaChat): number {
    return Math.max(1, Math.ceil(t.filas.length / this.FILAS_POR_PAGINA));
  }

  protected filasVisibles(t: TablaChat): ValorTabla[][] {
    const ini = ((t.pagina ?? 1) - 1) * this.FILAS_POR_PAGINA;
    return t.filas.slice(ini, ini + this.FILAS_POR_PAGINA);
  }

  protected paginar(index: number, nuevaPagina: number) {
    const m = this.mensajes()[index];
    const t = m?.tabla;
    if (!t || nuevaPagina < 1 || nuevaPagina > this.totalPaginas(t)) return;
    this.chat.actualizarMensaje(index, { ...m, tabla: { ...t, pagina: nuevaPagina } });
  }

  // Archivo que abre el botón de la fila: su archivo_id y, como nombre, la
  // columna "nombre" o "archivo" si la consulta la trajo.
  protected archivoDeFila(t: TablaChat, fila: ValorTabla[]): { id: string; nombre: string } | null {
    const iId = t.columnas.indexOf('archivo_id');
    const id = iId >= 0 ? fila[iId] : null;
    if (typeof id !== 'string' || !id) return null;
    const iNombre = ['nombre', 'archivo'].map((c) => t.columnas.indexOf(c)).find((i) => i >= 0);
    const nombre = iNombre !== undefined ? fila[iNombre] : null;
    return { id, nombre: typeof nombre === 'string' ? nombre : 'archivo' };
  }

  protected tieneArchivos(t: TablaChat): boolean {
    return t.columnas.includes('archivo_id');
  }

  // Formato de celda: números y fechas a la española, booleanos como Sí/No.
  // Importes con divisa si la fila trae una columna "moneda".
  private fmtNumero = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
  protected celda(t: TablaChat, fila: ValorTabla[], i: number): string {
    const v = fila[i];
    if (v === null || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    const columna = t.columnas[i];
    if (typeof v === 'number') {
      if (columna === 'tamano_bytes') return this.formatTamano(v);
      const iMoneda = t.columnas.indexOf('moneda');
      const esImporte = /total|subtotal|iva|importe|base|precio|gasto|venta|compra|media|beneficio/.test(columna);
      if (iMoneda >= 0 && esImporte && typeof fila[iMoneda] === 'string') {
        return this.formatImporte(v, fila[iMoneda] as string);
      }
      return this.fmtNumero.format(v);
    }
    const s = String(v);
    const fecha = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
    if (fecha) {
      const [, y, mo, d, h, mi] = fecha;
      if (!h) return `${d}/${mo}/${y}`;
      return new Date(s.replace(' ', 'T')).toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return s.length > 120 ? s.slice(0, 119) + '…' : s;
  }

  private formatTamano(bytes: number): string {
    const unidades = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let u = 0;
    while (n >= 1024 && u < unidades.length - 1) {
      n /= 1024;
      u++;
    }
    return `${this.fmtNumero.format(n)} ${unidades[u]}`;
  }

  // Formatea un importe con su divisa (es-ES: miles con ".", decimales con ","),
  // p. ej. (1234.5, "USD") → "1.234,50 US$". Si la moneda no es un código válido,
  // cae a un número con el código detrás, sin romper. Cachea el formateador por
  // divisa (las tablas pueden tener muchas filas).
  private fmtImporte = new Map<string, Intl.NumberFormat>();
  private formatImporte(total: number, moneda?: string): string {
    const cod = moneda || 'EUR';
    let fmt = this.fmtImporte.get(cod);
    if (!fmt) {
      try {
        fmt = new Intl.NumberFormat('es-ES', {
          style: 'currency',
          currency: cod,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      } catch {
        fmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      this.fmtImporte.set(cod, fmt);
    }
    const txt = fmt.format(total || 0);
    return /[^\d.,\s-]/.test(txt) ? txt : `${txt} ${cod}`;
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
              const cuerpo = esImagen ? `<img src="${url}">` : `<iframe src="${url}#zoom=100"></iframe>`;
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
