import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CompartidoService } from '../../core/compartido.service';
import { ToastService } from '../../core/toast.service';
import { Archivo } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';

// Vista de carpetas COMPARTIDAS por rol (se muestra en "Mis archivos" con el
// toggle Compartido). Almacenamiento único: lo que sube uno lo ven todos los del
// rol. Navegación carpeta a carpeta dentro de cada espacio compartido.
@Component({
  selector: 'app-compartido',
  imports: [DatePipe, FileSizePipe],
  template: `
    @if (carpeta() === null) {
      @if (carpetas().length === 0) {
        <div class="card empty">
          <div class="icon">📁</div>
          No tienes carpetas compartidas. El administrador puede crearlas y darte acceso por rol.
        </div>
      } @else {
        <div class="grid">
          @for (c of carpetas(); track c.id) {
            <button class="folder-card" (click)="abrir(c)">
              <span class="ico">📁</span>
              <span class="nom">{{ c.nombre }}</span>
            </button>
          }
        </div>
      }
    } @else {
      <div class="row barra">
        <button class="btn btn-ghost btn-sm" (click)="volver()">← Compartido</button>
        <span class="ruta">{{ carpeta()!.nombre }}{{ rutaActual() === '/' ? '' : rutaActual() }}</span>
        <span class="spacer"></span>
        <label class="btn btn-primary btn-sm">
          {{ subiendo() ? 'Subiendo…' : '+ Subir' }}
          <input type="file" multiple hidden (change)="onSubir($event)" [disabled]="subiendo()" />
        </label>
      </div>

      @if (cargando()) {
        <div class="card empty">Cargando…</div>
      } @else {
        <div class="card list">
          @if (rutaActual() !== '/') {
            <button class="fila nav" (click)="subirNivel()">📁 ..</button>
          }
          @for (sc of subcarpetas(); track sc) {
            <button class="fila nav" (click)="entrarSub(sc)">📁 {{ hoja(sc) }}</button>
          }
          @if (archivos().length === 0 && subcarpetas().length === 0 && rutaActual() === '/') {
            <div class="empty">Esta carpeta compartida está vacía. Sube el primer archivo.</div>
          }
          @if (archivos().length > 0) {
            <table class="table">
              <thead><tr><th>Nombre</th><th>Tamaño</th><th>Subido</th><th class="der">Acciones</th></tr></thead>
              <tbody>
                @for (a of archivos(); track a.id) {
                  <tr>
                    <td class="nombre">{{ a.nombre }}</td>
                    <td>{{ a.tamanoBytes | fileSize }}</td>
                    <td class="muted">{{ a.subidoEn | date: 'dd/MM/yy HH:mm' }}</td>
                    <td>
                      <div class="acciones">
                        <button class="btn btn-outline btn-sm" (click)="descargar(a)">Descargar</button>
                        <button class="btn btn-danger btn-sm" (click)="borrar(a)">Borrar</button>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }
    }
  `,
  styles: [`
    .grid { display: flex; flex-wrap: wrap; gap: 12px; }
    .folder-card {
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      width: 140px; padding: 18px; border: 1px solid var(--border);
      border-radius: var(--radius); background: var(--surface); cursor: pointer;
    }
    .folder-card:hover { border-color: var(--green); background: var(--green-soft); }
    .folder-card .ico { font-size: 2rem; }
    .folder-card .nom { font-weight: 600; text-align: center; word-break: break-word; }
    .barra { align-items: center; gap: 10px; margin-bottom: 10px; }
    .ruta { font-weight: 600; color: var(--muted); }
    .list { padding: 6px 8px; }
    .fila.nav {
      display: block; width: 100%; text-align: left; background: none; border: none;
      font: inherit; padding: 8px 10px; cursor: pointer; border-radius: 8px;
    }
    .fila.nav:hover { background: var(--green-soft); }
    .nombre { font-weight: 600; }
    .acciones { display: flex; gap: 6px; justify-content: flex-end; }
    .der { text-align: right; }
    label.btn input { display: none; }
  `],
})
export class CompartidoComponent {
  private svc = inject(CompartidoService);
  private toast = inject(ToastService);

  protected carpetas = signal<{ id: string; nombre: string }[]>([]);
  protected carpeta = signal<{ id: string; nombre: string } | null>(null);
  protected rutaActual = signal('/');
  protected archivos = signal<Archivo[]>([]);
  protected subcarpetas = signal<string[]>([]);
  protected cargando = signal(false);
  protected subiendo = signal(false);

  constructor() {
    this.cargarCarpetas();
  }

  cargarCarpetas() {
    this.svc.accesibles().subscribe({
      next: (c) => this.carpetas.set(c),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  abrir(c: { id: string; nombre: string }) {
    this.carpeta.set(c);
    this.rutaActual.set('/');
    this.cargarArchivos();
  }

  volver() {
    this.carpeta.set(null);
    this.archivos.set([]);
    this.subcarpetas.set([]);
  }

  cargarArchivos() {
    const c = this.carpeta();
    if (!c) return;
    this.cargando.set(true);
    this.svc.listarArchivos(c.id, this.rutaActual()).subscribe({
      next: (r) => {
        this.archivos.set(r.archivos);
        this.subcarpetas.set(r.subcarpetas);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  hoja(ruta: string): string {
    return ruta.split('/').filter(Boolean).pop() ?? ruta;
  }

  entrarSub(ruta: string) {
    this.rutaActual.set(ruta);
    this.cargarArchivos();
  }

  subirNivel() {
    const partes = this.rutaActual().split('/').filter(Boolean);
    partes.pop();
    this.rutaActual.set(partes.length ? `/${partes.join('/')}` : '/');
    this.cargarArchivos();
  }

  onSubir(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const c = this.carpeta();
    if (!files.length || !c) return;
    this.subiendo.set(true);
    let pendientes = files.length;
    for (const f of files) {
      this.svc.subir(c.id, f, this.rutaActual()).subscribe({
        next: () => {
          if (--pendientes === 0) this.finSubida(input);
        },
        error: (err) => {
          this.toast.error(mensajeError(err));
          if (--pendientes === 0) this.finSubida(input);
        },
      });
    }
  }

  private finSubida(input: HTMLInputElement) {
    this.subiendo.set(false);
    input.value = '';
    this.toast.exito('Subida completada');
    this.cargarArchivos();
  }

  descargar(a: Archivo) {
    this.svc.descargar(a.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = a.nombre;
        link.click();
        URL.revokeObjectURL(url);
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  borrar(a: Archivo) {
    this.svc.eliminarArchivo(a.id).subscribe({
      next: () => {
        this.toast.exito('Archivo borrado');
        this.cargarArchivos();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
}
