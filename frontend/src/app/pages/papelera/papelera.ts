import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { Archivo } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-papelera',
  imports: [DatePipe, FileSizePipe],
  template: `
    <div class="head row">
      <div>
        <h1>Papelera</h1>
        <p class="muted">{{ archivos().length }} archivo(s) eliminado(s)</p>
      </div>
      <span class="spacer"></span>
      @if (archivos().length > 0) {
        <button class="btn btn-danger" (click)="vaciar()">Vaciar papelera</button>
      }
    </div>

    <div class="card list">
      @if (cargando()) {
        <div class="empty">Cargando…</div>
      } @else if (archivos().length === 0) {
        <div class="empty">
          <div class="icon">🧹</div>
          La papelera está vacía.
        </div>
      } @else {
        <table class="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Carpeta</th>
              <th>Tamaño</th>
              <th>Eliminado</th>
              <th class="acciones-col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            @for (a of archivos(); track a.id) {
              <tr>
                <td class="nombre">{{ a.nombre }}</td>
                <td><span class="badge badge-muted">{{ a.carpeta }}</span></td>
                <td>{{ a.tamanoBytes | fileSize }}</td>
                <td class="muted">{{ a.eliminadoEn | date: 'dd/MM/yy HH:mm' }}</td>
                <td>
                  <div class="acciones">
                    <button class="btn btn-outline btn-sm" (click)="restaurar(a)">
                      Restaurar
                    </button>
                    <button class="btn btn-danger btn-sm" (click)="borrar(a)">
                      Borrar
                    </button>
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <!-- Modal de confirmación -->
    @if (confirmacion(); as c) {
      <div class="modal-backdrop" (click)="confirmacion.set(null)">
        <div class="card modal" (click)="$event.stopPropagation()">
          <h2>{{ c.titulo }}</h2>
          <p class="muted" style="margin-bottom: 16px;">{{ c.mensaje }}</p>
          <div class="row" style="justify-content: flex-end;">
            <button class="btn btn-ghost" (click)="confirmacion.set(null)">Cancelar</button>
            <button class="btn btn-danger" (click)="ejecutarConfirmacion()">{{ c.accion }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .head {
        margin-bottom: 18px;
      }
      .list {
        padding: 6px 8px;
      }
      .nombre {
        font-weight: 600;
      }
      .acciones {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .acciones-col {
        text-align: right;
      }
    `,
  ],
})
export class PapeleraPage {
  private svc = inject(ArchivosService);
  private toast = inject(ToastService);

  protected archivos = signal<Archivo[]>([]);
  protected cargando = signal(false);
  protected confirmacion = signal<{
    titulo: string;
    mensaje: string;
    accion: string;
    onOk: () => void;
  } | null>(null);

  ejecutarConfirmacion() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    c?.onOk();
  }

  constructor() {
    this.cargar();
  }

  cargar() {
    this.cargando.set(true);
    this.svc.listarPapelera().subscribe({
      next: (a) => {
        this.archivos.set(a);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  restaurar(a: Archivo) {
    this.svc.restaurar(a.id).subscribe({
      next: () => {
        this.toast.exito('Archivo restaurado');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  borrar(a: Archivo) {
    this.confirmacion.set({
      titulo: 'Borrar definitivamente',
      mensaje: `Borrar "${a.nombre}" permanentemente. Esta acción no se puede deshacer.`,
      accion: 'Borrar',
      onOk: () =>
        this.svc.borrarPermanente(a.id).subscribe({
          next: () => {
            this.toast.exito('Archivo borrado definitivamente');
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }

  vaciar() {
    this.confirmacion.set({
      titulo: 'Vaciar papelera',
      mensaje: 'Vaciar la papelera borrará todo permanentemente. ¿Continuar?',
      accion: 'Vaciar papelera',
      onOk: () =>
        this.svc.vaciarPapelera().subscribe({
          next: (r) => {
            this.toast.exito(`Papelera vaciada (${r.borrados})`);
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }
}
