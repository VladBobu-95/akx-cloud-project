import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { Archivo } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-papelera',
  imports: [DatePipe, FileSizePipe, FormsModule],
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

  // --- Paginación (en cliente: la papelera trae todos los eliminados) ---
  protected readonly OPCIONES_TAMANO = [10, 15, 20, 50];
  protected tamanoPagina = signal(15);
  protected pagina = signal(0);
  protected totalPaginas = computed(() => Math.max(1, Math.ceil(this.archivos().length / this.tamanoPagina())));
  protected archivosPag = computed(() => {
    const ini = this.pagina() * this.tamanoPagina();
    return this.archivos().slice(ini, ini + this.tamanoPagina());
  });
  protected paginaAnterior() {
    if (this.pagina() > 0) this.pagina.update((p) => p - 1);
  }
  protected paginaSiguiente() {
    if (this.pagina() < this.totalPaginas() - 1) this.pagina.update((p) => p + 1);
  }
  protected cambiarTamano(valor: number) {
    this.tamanoPagina.set(valor);
    this.pagina.set(0);
  }
  protected irAPagina(valor: string | number) {
    const n = Math.trunc(Number(valor));
    if (!Number.isFinite(n) || n < 1) return;
    this.pagina.set(Math.min(n, this.totalPaginas()) - 1);
  }

  // --- Selección múltiple (igual que en el explorador) ---
  protected seleccionados = signal<Set<string>>(new Set());
  protected haySeleccion = computed(() => this.seleccionados().size > 0);
  protected numSeleccionados = computed(() => this.seleccionados().size);
  protected todosSeleccionados = computed(() => {
    const total = this.archivos().length;
    return total > 0 && this.seleccionados().size === total;
  });

  protected estaSeleccionado(id: string): boolean {
    return this.seleccionados().has(id);
  }
  protected toggleSeleccion(ev: Event, id: string) {
    ev.stopPropagation();
    const s = new Set(this.seleccionados());
    s.has(id) ? s.delete(id) : s.add(id);
    this.seleccionados.set(s);
  }
  protected toggleTodo() {
    this.seleccionados.set(
      this.todosSeleccionados() ? new Set() : new Set(this.archivos().map((a) => a.id)),
    );
  }
  protected limpiarSeleccion() {
    this.seleccionados.set(new Set());
  }

  protected restaurarSeleccion() {
    const ids = [...this.seleccionados()];
    const n = ids.length;
    forkJoin(ids.map((id) => this.svc.restaurar(id))).subscribe({
      next: () => {
        this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} restaurado${n !== 1 ? 's' : ''}`);
        this.limpiarSeleccion();
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  protected pedirBorrarSeleccion() {
    const n = this.seleccionados().size;
    this.confirmacion.set({
      titulo: 'Borrar definitivamente',
      mensaje: `Borrar ${n} elemento${n !== 1 ? 's' : ''} permanentemente. Esta acción no se puede deshacer.`,
      accion: 'Borrar',
      onOk: () => {
        const ids = [...this.seleccionados()];
        forkJoin(ids.map((id) => this.svc.borrarPermanente(id))).subscribe({
          next: () => {
            this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} borrado${n !== 1 ? 's' : ''} definitivamente`);
            this.limpiarSeleccion();
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        });
      },
    });
  }

  ejecutarConfirmacion() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    c?.onOk();
  }

  constructor() {
    this.cargar();
    // Si al restaurar/borrar la lista se acorta y la página queda fuera de rango,
    // la fijamos a la última válida.
    effect(() => {
      const tp = this.totalPaginas();
      this.pagina.update((p) => (p > tp - 1 ? tp - 1 : p));
    });
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
