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
  templateUrl: './papelera.html',
  styleUrl: './papelera.scss',
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
