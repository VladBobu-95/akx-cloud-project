import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of, catchError } from 'rxjs';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { Archivo } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';
import { normalizarRuta, padre, nombreHoja } from '../archivos/rutas.util';

// Papelera con la MISMA estructura que "Mis archivos": carpetas + ficheros
// navegables. El árbol se deriva de las rutas (`carpeta`) de los archivos
// eliminados (no hay metadata de carpetas vacías en la papelera: una carpeta
// aparece si contiene algún archivo borrado). Las acciones son las propias de la
// papelera: Restaurar y Borrar definitivamente (por archivo, por carpeta o en
// bloque), más Vaciar. Sin subir/mover/copiar/IA (no aplican a la papelera).
@Component({
  selector: 'app-papelera',
  imports: [DatePipe, FileSizePipe, FormsModule],
  templateUrl: './papelera.html',
  styleUrl: './papelera.scss',
})
export class PapeleraPage {
  private svc = inject(ArchivosService);
  private toast = inject(ToastService);

  protected todos = signal<Archivo[]>([]);
  protected cargando = signal(false);
  protected rutaActual = signal<string>('/');
  protected confirmacion = signal<{
    titulo: string;
    mensaje: string;
    accion: string;
    onOk: () => void;
  } | null>(null);

  // Helpers de rutas (funciones puras compartidas con el explorador).
  protected readonly normalizar = normalizarRuta;
  protected readonly padre = padre;
  protected readonly nombreHoja = nombreHoja;

  // --- Árbol derivado de las rutas de los archivos eliminados ---
  // Todas las rutas de carpeta conocidas (las de los archivos + sus ancestros).
  private rutasConocidas = computed(() => {
    const set = new Set<string>();
    for (const a of this.todos()) {
      let r = this.normalizar(a.carpeta);
      while (r !== '/') {
        set.add(r);
        r = this.padre(r);
      }
    }
    return set;
  });

  // Subcarpetas inmediatas de la ruta actual.
  protected subcarpetas = computed(() => {
    const actual = this.rutaActual();
    return [...this.rutasConocidas()]
      .filter((r) => this.padre(r) === actual)
      .sort((a, b) => this.nombreHoja(a).localeCompare(this.nombreHoja(b)));
  });

  // Archivos directamente en la ruta actual.
  protected archivosActuales = computed(() =>
    this.todos().filter((a) => this.normalizar(a.carpeta) === this.rutaActual()),
  );

  // Archivos cuya carpeta es `ruta` o cuelga de su subárbol.
  private archivosBajo(ruta: string): Archivo[] {
    return this.todos().filter((a) => {
      const c = this.normalizar(a.carpeta);
      return c === ruta || c.startsWith(ruta + '/');
    });
  }
  // Tamaño total (bytes) del subárbol de una carpeta.
  protected tamanoCarpeta(ruta: string): number {
    return this.archivosBajo(ruta).reduce((s, a) => s + Number(a.tamanoBytes ?? 0), 0);
  }
  // Fecha de eliminación más reciente del contenido de la carpeta.
  protected fechaCarpeta(ruta: string): string | null {
    const fechas = this.archivosBajo(ruta).map((a) => a.eliminadoEn).filter((f): f is string => !!f);
    if (fechas.length === 0) return null;
    return fechas.reduce((max, f) => (f > max ? f : max));
  }

  // --- Navegación ---
  entrar(ruta: string) {
    this.rutaActual.set(ruta);
    this.pagina.set(0);
    this.limpiarSeleccion();
  }
  volver() {
    if (this.rutaActual() !== '/') {
      this.rutaActual.set(this.padre(this.rutaActual()));
      this.pagina.set(0);
      this.limpiarSeleccion();
    }
  }

  // --- Paginación (en cliente: la papelera trae todos los eliminados) ---
  // Carpetas y archivos forman UNA secuencia (carpetas primero) partida en páginas.
  protected readonly OPCIONES_TAMANO = [10, 15, 20, 50];
  protected tamanoPagina = signal(15);
  protected pagina = signal(0);
  protected totalFilas = computed(() => this.subcarpetas().length + this.archivosActuales().length);
  protected totalPaginas = computed(() => Math.max(1, Math.ceil(this.totalFilas() / this.tamanoPagina())));

  protected subcarpetasPag = computed(() => {
    const f = this.subcarpetas().length;
    const ini = this.pagina() * this.tamanoPagina();
    return this.subcarpetas().slice(Math.min(ini, f), Math.min(ini + this.tamanoPagina(), f));
  });
  protected archivosActualesPag = computed(() => {
    const f = this.subcarpetas().length;
    const a = this.archivosActuales().length;
    const ini = this.pagina() * this.tamanoPagina();
    const desde = Math.max(0, Math.min(ini - f, a));
    const hasta = Math.max(0, Math.min(ini + this.tamanoPagina() - f, a));
    return this.archivosActuales().slice(desde, hasta);
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

  // --- Selección múltiple (claves: 'f:<id>' archivos, 'd:<ruta>' carpetas) ---
  protected seleccionados = signal<Set<string>>(new Set());
  protected haySeleccion = computed(() => this.seleccionados().size > 0);
  protected numSeleccionados = computed(() => this.seleccionados().size);
  protected claveCarpeta(ruta: string) { return `d:${ruta}`; }
  protected claveArchivo(id: string) { return `f:${id}`; }
  protected estaSeleccionado(clave: string): boolean { return this.seleccionados().has(clave); }

  // "Seleccionar todo" se limita a lo visible en la página actual.
  protected clavesPaginaActual = computed(() => {
    const claves: string[] = [];
    for (const c of this.subcarpetasPag()) claves.push(this.claveCarpeta(c));
    for (const a of this.archivosActualesPag()) claves.push(this.claveArchivo(a.id));
    return claves;
  });
  protected todosSeleccionados = computed(() => {
    const claves = this.clavesPaginaActual();
    const sel = this.seleccionados();
    return claves.length > 0 && claves.every((k) => sel.has(k));
  });

  protected toggleSeleccion(ev: Event, clave: string) {
    ev.stopPropagation();
    const s = new Set(this.seleccionados());
    s.has(clave) ? s.delete(clave) : s.add(clave);
    this.seleccionados.set(s);
  }
  protected toggleTodo() {
    const claves = this.clavesPaginaActual();
    const s = new Set(this.seleccionados());
    if (this.todosSeleccionados()) {
      for (const k of claves) s.delete(k);
    } else {
      for (const k of claves) s.add(k);
    }
    this.seleccionados.set(s);
  }
  protected limpiarSeleccion() {
    this.seleccionados.set(new Set());
  }

  // Archivos afectados por la selección (archivos sueltos + los de las carpetas).
  private archivosDeSeleccion(): Archivo[] {
    const sel = [...this.seleccionados()];
    const ids = new Set(sel.filter((k) => k.startsWith('f:')).map((k) => k.slice(2)));
    const carpRutas = sel.filter((k) => k.startsWith('d:')).map((k) => k.slice(2));
    for (const ruta of carpRutas) for (const a of this.archivosBajo(ruta)) ids.add(a.id);
    return this.todos().filter((a) => ids.has(a.id));
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
        this.todos.set(a);
        // Si la carpeta en la que estábamos ya no tiene contenido, subimos a la raíz.
        if (this.rutaActual() !== '/' && !this.rutasConocidas().has(this.rutaActual())) {
          this.rutaActual.set('/');
          this.pagina.set(0);
        }
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Restaurar ---
  restaurar(a: Archivo) {
    this.svc.restaurar(a.id).subscribe({
      next: () => {
        this.toast.exito('Archivo restaurado');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  restaurarCarpeta(ruta: string) {
    const afectados = this.archivosBajo(ruta);
    if (afectados.length === 0) return;
    forkJoin(afectados.map((a) => this.svc.restaurar(a.id))).subscribe({
      next: () => {
        this.toast.exito('Carpeta restaurada');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  protected restaurarSeleccion() {
    const afectados = this.archivosDeSeleccion();
    const n = afectados.length;
    if (n === 0) return;
    forkJoin(afectados.map((a) => this.svc.restaurar(a.id))).subscribe({
      next: () => {
        this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} restaurado${n !== 1 ? 's' : ''}`);
        this.limpiarSeleccion();
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Borrar definitivamente ---
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
  pedirBorrarCarpeta(ruta: string) {
    const afectados = this.archivosBajo(ruta);
    const n = afectados.length;
    this.confirmacion.set({
      titulo: 'Borrar carpeta definitivamente',
      mensaje: `Borrar la carpeta "${this.nombreHoja(ruta)}" y sus ${n} archivo${n !== 1 ? 's' : ''} permanentemente. Esta acción no se puede deshacer.`,
      accion: 'Borrar',
      onOk: () => {
        if (afectados.length === 0) return;
        forkJoin(afectados.map((a) => this.svc.borrarPermanente(a.id).pipe(catchError(() => of(null))))).subscribe(
          () => {
            this.toast.exito('Carpeta borrada definitivamente');
            this.cargar();
          },
        );
      },
    });
  }
  protected pedirBorrarSeleccion() {
    const afectados = this.archivosDeSeleccion();
    const n = afectados.length;
    if (n === 0) return;
    this.confirmacion.set({
      titulo: 'Borrar definitivamente',
      mensaje: `Borrar ${n} elemento${n !== 1 ? 's' : ''} permanentemente. Esta acción no se puede deshacer.`,
      accion: 'Borrar',
      onOk: () => {
        forkJoin(afectados.map((a) => this.svc.borrarPermanente(a.id).pipe(catchError(() => of(null))))).subscribe(
          () => {
            this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} borrado${n !== 1 ? 's' : ''} definitivamente`);
            this.limpiarSeleccion();
            this.cargar();
          },
        );
      },
    });
  }

  ejecutarConfirmacion() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    c?.onOk();
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
            this.rutaActual.set('/');
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }
}
