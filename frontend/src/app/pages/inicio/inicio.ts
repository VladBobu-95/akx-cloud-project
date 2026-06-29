import { AfterViewInit, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { AuthService } from '../../core/auth.service';
import { ChatService, TablaAclaracion, TablaCarpetas } from '../../core/chat.service';
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

  // El historial y el borrador viven en el servicio (persisten al cambiar de
  // página; el historial sobrevive también a recargar).
  protected mensajes = this.chat.mensajes;
  protected pensando = signal(false);

  private mensajesEl = viewChild<ElementRef<HTMLDivElement>>('mensajesContainer');

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
    if (!texto || this.pensando()) return;
    this.chat.borrador.set('');
    this.enviarTexto(texto);
  }

  // Pulsar una fila de la tabla de aclaración manda su `valor` igual que si el
  // usuario lo hubiera escrito y dado a Enter (para que la burbuja lea bien),
  // más el `id` exacto de la opción (si la tiene) como `idOpcion`: el backend
  // lo usa para resolverla sin ambigüedad en vez de re-comparar texto (dos
  // opciones pueden compartir el mismo nombre en carpetas distintas).
  protected seleccionarAclaracion(valor: string, id?: string) {
    this.enviarTexto(valor, id);
  }

  private enviarTexto(texto: string, idOpcion?: string) {
    if (!texto || this.pensando()) return;

    this.chat.añadir({ de: 'usuario', texto });
    this.scrollAbajo();
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

    this.chat.enviar(historial, idOpcion).subscribe({
      next: (r) => {
        const extra = r.acciones?.length ? '\n\n' + r.acciones.map((a) => `✓ ${a}`).join('\n') : '';
        this.chat.añadir({
          de: 'bot',
          texto: r.respuesta + extra,
          archivos: r.archivos,
          tablaFacturas: r.tablaFacturas,
          tablaArchivos: r.tablaArchivos,
          tablaCarpetas: r.tablaCarpetas,
          tablaAclaracion: r.tablaAclaracion,
        });
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

  // --- Paginación de las tablas del chat ---
  // Facturas y archivos piden la página al backend (REST) reenviando filtro/carpeta;
  // se sustituye la tabla del mensaje (in situ) con las filas nuevas.
  protected paginarFacturas(index: number, nuevaPagina: number) {
    const m = this.mensajes()[index];
    const t = m?.tablaFacturas;
    if (!t || nuevaPagina < 1 || nuevaPagina > t.totalPaginas) return;
    this.chat.masFacturas(t.filtro, nuevaPagina, t.limite).subscribe({
      next: (r) =>
        this.chat.actualizarMensaje(index, {
          ...m,
          tablaFacturas: { ...t, pagina: nuevaPagina, totalPaginas: r.paginas, total: r.total, filas: r.filas },
        }),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  protected paginarArchivos(index: number, nuevaPagina: number) {
    const m = this.mensajes()[index];
    const t = m?.tablaArchivos;
    if (!t || nuevaPagina < 1 || nuevaPagina > t.totalPaginas) return;
    this.archivosSvc.listar(t.carpeta, nuevaPagina, t.limite).subscribe({
      next: (r) =>
        this.chat.actualizarMensaje(index, {
          ...m,
          tablaArchivos: {
            ...t,
            pagina: r.pagina,
            totalPaginas: r.paginas,
            total: r.total,
            filas: r.archivos.map((a) => ({
              id: a.id,
              nombre: a.nombre,
              carpeta: a.carpeta,
              tamanoBytes: String(a.tamanoBytes),
              subidoEn: String(a.subidoEn),
            })),
          },
        }),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // Carpetas: todas las filas vienen en el mensaje, se pagina en memoria.
  protected totalPaginasCarpetas(t: TablaCarpetas): number {
    return Math.max(1, Math.ceil(t.filas.length / t.limite));
  }
  protected filasCarpetasVisibles(t: TablaCarpetas): { ruta: string }[] {
    const pagina = t.pagina ?? 1;
    const ini = (pagina - 1) * t.limite;
    return t.filas.slice(ini, ini + t.limite);
  }
  protected paginarCarpetas(index: number, nuevaPagina: number) {
    const m = this.mensajes()[index];
    const t = m?.tablaCarpetas;
    if (!t || nuevaPagina < 1 || nuevaPagina > this.totalPaginasCarpetas(t)) return;
    this.chat.actualizarMensaje(index, { ...m, tablaCarpetas: { ...t, pagina: nuevaPagina } });
  }

  // Aclaración: igual que carpetas, todas las opciones vienen en el mensaje y se
  // pagina en memoria (normalmente son pocas, pero por si hay muchas coincidencias).
  protected totalPaginasAclaracion(t: TablaAclaracion): number {
    return Math.max(1, Math.ceil(t.filas.length / t.limite));
  }
  protected filasAclaracionVisibles(t: TablaAclaracion): { etiqueta: string; valor: string; id?: string }[] {
    const pagina = t.pagina ?? 1;
    const ini = (pagina - 1) * t.limite;
    return t.filas.slice(ini, ini + t.limite);
  }
  protected paginarAclaracion(index: number, nuevaPagina: number) {
    const m = this.mensajes()[index];
    const t = m?.tablaAclaracion;
    if (!t || nuevaPagina < 1 || nuevaPagina > this.totalPaginasAclaracion(t)) return;
    this.chat.actualizarMensaje(index, { ...m, tablaAclaracion: { ...t, pagina: nuevaPagina } });
  }

  // Formatea un importe con su divisa (es-ES: miles con ".", decimales con ","),
  // p. ej. (1234.5, "USD") → "1.234,50 US$". Si la moneda no es un código válido,
  // cae a un número con el código detrás, sin romper. Cachea el formateador por
  // divisa (las tablas de facturas pueden tener muchas filas).
  private fmtImporte = new Map<string, Intl.NumberFormat>();
  protected formatImporte(total: number, moneda?: string): string {
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
