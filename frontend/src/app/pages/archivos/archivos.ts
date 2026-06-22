import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of, map, catchError, finalize } from 'rxjs';
import { marked } from 'marked';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { Archivo, ResultadoBusqueda } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';
import { normalizarRuta, unir, padre, nombreHoja } from './rutas.util';

// Payload de lo que se está arrastrando: un archivo (por id) o una carpeta (por ruta).
interface Arrastre {
  tipo: 'archivo' | 'carpeta';
  ref: string;
  nombre: string;
}

@Component({
  selector: 'app-archivos',
  imports: [FormsModule, DatePipe, FileSizePipe],
  templateUrl: './archivos.html',
  styleUrl: './archivos.scss',
})
export class ArchivosPage {
  private svc = inject(ArchivosService);
  private toast = inject(ToastService);

  protected todos = signal<Archivo[]>([]);
  protected cargando = signal(false);
  protected rutaActual = signal<string>('/');
  // Carpetas creadas localmente (persisten aunque estén vacías). Guardamos su
  // fecha de creación para mostrarla en la columna "Subido".
  protected carpetas = signal<{ ruta: string; creada: string }[]>([]);

  protected subiendo = signal(false);
  protected subidaRestantes = signal(0); // archivos que faltan por subir
  protected etiquetaSubir = computed(() =>
    this.subiendo() ? `Subiendo… (${this.subidaRestantes()})` : ' Subir archivos',
  );

  // Búsqueda semántica (RAG). resultados = null → aún no se ha buscado.
  protected consulta = '';
  protected buscando = signal(false);
  protected resultados = signal<ResultadoBusqueda[] | null>(null);
  protected ultimaConsulta = signal('');

  protected editando = signal<{ id: string; nombre: string; carpeta: string } | null>(null);

  // Modales propios (en lugar de prompt/confirm del navegador).
  protected modalCarpeta = signal(false);
  protected nombreNueva = '';
  protected renombrarModal = signal<{ origen: string } | null>(null);
  protected nombreRenombrar = '';
  protected moverModal = signal<{ tipo: 'archivo' | 'carpeta'; ref: string } | null>(null);
  protected descripcionModal = signal<{ id: string; nombre: string } | null>(null);
  protected textoDescripcion = '';
  protected guardandoDescripcion = signal(false);
  // Visor de markdown renderizado (.md): título + HTML ya convertido.
  protected verMd = signal<{ nombre: string; html: string } | null>(null);
  protected confirmacion = signal<{
    titulo: string;
    mensaje: string;
    accion: string;
    onOk: () => void;
  } | null>(null);

  // Menú contextual (clic derecho).
  protected menu = signal<{ x: number; y: number; tipo: 'archivo' | 'carpeta'; ref: string } | null>(
    null,
  );

  // Arrastre propio (basado en eventos de puntero).
  protected arrastrando = signal<Arrastre | null>(null);
  protected ghostPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  // Destino actual bajo el puntero: ruta de carpeta, o '..' (mover al padre).
  protected destinoHover = signal<string | null>(null);
  // Candidato de arrastre registrado en pointerdown, antes de superar el umbral.
  private pendiente: { tipo: 'archivo' | 'carpeta'; ref: string; nombre: string; x0: number; y0: number } | null =
    null;

  protected total = computed(() => this.todos().length);

  // El escaneo de facturas va en segundo plano y puede tardar minutos; mientras
  // haya algo en cola, refrescamos solos el listado cada 5s para que "Estado"
  // se actualice sin recargar la página a mano. Se para sola en cuanto no
  // queda nada pendiente/escaneando.
  private hayEscaneoEnCurso = computed(() =>
    this.todos().some((a) => a.estadoEscaneo === 'pendiente' || a.estadoEscaneo === 'escaneando'),
  );

  // Conjunto de todas las rutas de carpeta conocidas: las de los archivos (con
  // sus ancestros) más las carpetas vacías guardadas en localStorage.
  private rutasConocidas = computed(() => {
    const set = new Set<string>();
    const anadir = (ruta: string) => {
      let r = ruta;
      while (r !== '/') {
        set.add(r);
        r = this.padre(r);
      }
    };
    for (const a of this.todos()) anadir(this.normalizar(a.carpeta));
    for (const c of this.carpetas()) anadir(c.ruta);
    return set;
  });

  // Subcarpetas inmediatas de la ruta actual.
  protected subcarpetas = computed(() => {
    const actual = this.rutaActual();
    return [...this.rutasConocidas()]
      .filter((r) => this.padre(r) === actual)
      .sort((a, b) => this.nombreHoja(a).localeCompare(this.nombreHoja(b)));
  });

  // Archivos que están directamente en la ruta actual.
  protected archivosActuales = computed(() =>
    this.todos().filter((a) => this.normalizar(a.carpeta) === this.rutaActual()),
  );

  constructor() {
    this.cargar();
    const id = setInterval(() => {
      if (this.hayEscaneoEnCurso()) this.refrescarEstados();
    }, 3000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  // Refresco silencioso (sin tocar `cargando`, que mostraría "Cargando…" y
  // ocultaría la tabla): solo actualiza los datos de los archivos para que se
  // vea el cambio de estado del escaneo.
  private refrescarEstados() {
    this.svc.listarTodos().subscribe({
      next: (archivos) => this.todos.set(archivos),
      error: () => {},
    });
  }

  // --- Helpers de rutas ---
  // La lógica vive en `rutas.util.ts` (funciones puras, testeables aparte). Aquí
  // se exponen como miembros para poder usarlas también desde el template.
  protected readonly normalizar = normalizarRuta;
  protected readonly unir = unir;
  protected readonly padre = padre;
  protected readonly nombreHoja = nombreHoja;

  // Tamaño total (suma de los bytes) de los archivos del subárbol de la carpeta.
  protected tamanoCarpeta(ruta: string): number {
    return this.archivosBajo(ruta).reduce((s, a) => s + Number(a.tamanoBytes ?? 0), 0);
  }
  // Fecha de la carpeta = su fecha de creación local. Si la carpeta no se creó
  // explícitamente (apareció al subir un archivo en una ruta anidada), usamos la
  // fecha de subida más antigua de su contenido. null si no hay nada.
  protected fechaCarpeta(ruta: string): string | null {
    const creada = this.carpetas().find((c) => c.ruta === ruta)?.creada;
    if (creada) return creada;
    const fechas = this.archivosBajo(ruta).map((a) => a.subidoEn);
    if (fechas.length === 0) return null;
    return fechas.reduce((min, f) => (f < min ? f : min));
  }

  // --- Carga ---
  cargar() {
    this.cargando.set(true);
    forkJoin({
      archivos: this.svc.listarTodos(),
      carpetas: this.svc.listarCarpetas(),
    }).subscribe({
      next: ({ archivos, carpetas }) => {
        this.todos.set(archivos);
        this.carpetas.set(carpetas);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Búsqueda semántica ---
  buscar() {
    const q = this.consulta.trim();
    if (!q || this.buscando()) return;
    this.buscando.set(true);
    this.ultimaConsulta.set(q);
    this.svc.buscarSemantica(q).subscribe({
      next: (res) => {
        this.resultados.set(res);
        this.buscando.set(false);
      },
      error: (err) => {
        this.buscando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }
  limpiarBusqueda() {
    this.consulta = '';
    this.resultados.set(null);
    this.ultimaConsulta.set('');
  }
  // Lleva a la carpeta donde está el archivo del resultado.
  irAArchivo(carpeta: string) {
    this.rutaActual.set(this.normalizar(carpeta));
    this.limpiarBusqueda();
  }

  // --- Navegación ---
  entrar(ruta: string) {
    this.rutaActual.set(ruta);
    this.limpiarSeleccion();
  }
  volver() {
    if (this.rutaActual() !== '/') {
      this.rutaActual.set(this.padre(this.rutaActual()));
      this.limpiarSeleccion();
    }
  }

  // --- Carpetas (persistidas en el backend) ---
  abrirNuevaCarpeta() {
    this.nombreNueva = '';
    this.modalCarpeta.set(true);
  }
  cerrarNuevaCarpeta() {
    this.modalCarpeta.set(false);
  }
  crearCarpeta() {
    const nombre = this.nombreNueva.trim();
    if (!nombre) return;
    if (nombre.includes('/')) {
      this.toast.error('El nombre no puede contener "/"');
      return;
    }
    const ruta = this.unir(this.rutaActual(), nombre);
    if (this.rutasConocidas().has(ruta)) {
      this.toast.error('Ya existe una carpeta con ese nombre');
      return;
    }
    this.modalCarpeta.set(false);
    this.svc.crearCarpetaApi(ruta).subscribe({
      next: () => {
        this.carpetas.update((v) => [...v, { ruta, creada: new Date().toISOString() }]);
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Subir (un solo clic: se sube a la carpeta actual) ---
  seleccionar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length) this.subirVarios(files);
    input.value = ''; // permite volver a elegir los mismos archivos
  }
  // Sube varios archivos a la carpeta actual. Cada uno va en su propia petición
  // (el backend acepta uno por subida) y capturamos el error de cada uno para
  // que un fallo no aborte el resto. Al terminar, recarga y muestra un resumen.
  private subirVarios(files: File[]) {
    this.subiendo.set(true);
    this.subidaRestantes.set(files.length);
    const carpeta = this.rutaActual();
    const subidas = files.map((f) =>
      this.svc.subir(f, carpeta).pipe(
        map((archivo) => ({ ok: true as const, archivo })),
        catchError(() => of({ ok: false as const, archivo: null })),
        finalize(() => this.subidaRestantes.update((n) => n - 1)),
      ),
    );
    forkJoin(subidas).subscribe((resultados) => {
      const ok = resultados.filter((r) => r.ok).length;
      const fallidos = resultados.length - ok;
      this.subiendo.set(false);
      this.subidaRestantes.set(0);
      if (fallidos === 0) {
        this.toast.exito(ok === 1 ? 'Archivo subido' : `${ok} archivos subidos`);
      } else {
        this.toast.error(`${ok} subido(s), ${fallidos} fallaron`);
      }
      this.cargar();
    });
  }

  // --- Acciones de archivo ---
  // Tipos que el navegador sabe mostrar directamente.
  private esPrevisualizable(mimeType: string): boolean {
    return /^(application\/pdf|image\/|text\/)/.test(mimeType ?? '');
  }
  private esMarkdown(a: Archivo): boolean {
    return a.mimeType === 'text/markdown' || a.nombre.toLowerCase().endsWith('.md');
  }
  // Abre el archivo: los .md se renderizan en un modal (bonito); los demás
  // previsualizables (PDF, imagen, texto) en una pestaña nueva; el resto se descargan.
  abrir(a: Archivo) {
    if (this.esMarkdown(a)) {
      this.svc.descargar(a.id).subscribe({
        next: async (blob) => {
          const texto = await blob.text();
          const html = await marked.parse(texto);
          this.verMd.set({ nombre: a.nombre, html });
        },
        error: (err) => this.toast.error(mensajeError(err)),
      });
      return;
    }
    if (!this.esPrevisualizable(a.mimeType)) {
      this.descargar(a);
      return;
    }
    // Abrimos la pestaña YA (en el gesto del clic) para que el navegador no la
    // bloquee como pop-up. Escribimos un HTML propio con el <title> correcto e
    // incrustamos el blob en un <iframe> o <img> según el tipo — así la pestaña
    // nunca muestra "(anonymous)" aunque sea una blob URL sin nombre.
    const win = window.open('', '_blank');
    const nombre = a.nombre;
    const mimeType = a.mimeType;
    this.svc.descargar(a.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        if (win) {
          const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const esImagen = /^image\//.test(mimeType);
          const cuerpo = esImagen
            ? `<img src="${url}">`
            : `<iframe src="${url}"></iframe>`;
          const estilos = esImagen
            ? `body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;}img{max-width:100%;max-height:100vh;object-fit:contain;}`
            : `html,body{height:100%;margin:0;padding:0;overflow:hidden;}iframe{width:100%;height:100%;border:none;}`;
          win.document.write(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(nombre)}</title>` +
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
  }
  descargar(a: Archivo) {
    this.svc.descargar(a.id).subscribe({
      next: (blob) => this.guardarBlob(blob, a.nombre),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  private guardarBlob(blob: Blob, nombre: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
  }
  abrirEdicion(a: Archivo) {
    this.editando.set({ id: a.id, nombre: a.nombre, carpeta: a.carpeta });
  }
  guardarEdicion() {
    const ed = this.editando();
    if (!ed) return;
    this.svc.actualizar(ed.id, { nombre: ed.nombre, carpeta: ed.carpeta }).subscribe({
      next: () => {
        this.toast.exito('Archivo actualizado');
        this.editando.set(null);
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  copiarArchivo(a: Archivo) {
    this.svc.copiar(a.id, { carpeta: this.normalizar(a.carpeta), nombre: `${a.nombre} (copia)` }).subscribe({
      next: () => {
        this.toast.exito('Archivo copiado');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  pedirEliminar(a: Archivo) {
    this.confirmacion.set({
      titulo: 'Mover a la papelera',
      mensaje: `¿Mover "${a.nombre}" a la papelera?`,
      accion: 'Mover a papelera',
      onOk: () => this.eliminar(a),
    });
  }
  private eliminar(a: Archivo) {
    this.svc.eliminar(a.id).subscribe({
      next: () => {
        this.toast.exito('Movido a la papelera');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Confirmación genérica ---
  ejecutarConfirmacion() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    c?.onOk();
  }

  // --- Menú contextual ---
  abrirMenu(ev: MouseEvent, tipo: 'archivo' | 'carpeta', ref: string) {
    ev.preventDefault();
    // Clamp para que el menú no se salga por la derecha/abajo.
    const x = Math.min(ev.clientX, window.innerWidth - 210);
    const y = Math.min(ev.clientY, window.innerHeight - 260);
    this.menu.set({ x, y, tipo, ref });
  }
  cerrarMenu() {
    this.menu.set(null);
  }
  private archivoPorId(id: string): Archivo | undefined {
    return this.todos().find((a) => a.id === id);
  }
  accionAbrirArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.abrir(a);
  }
  // Todo se escanea/indexa automáticamente al subir; este modal sirve para
  // AÑADIR una descripción a mano (sobre todo a fotos) y que se pueda encontrar
  // por contenido en el buscador semántico.
  accionDescribir(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) {
      this.textoDescripcion = '';
      this.descripcionModal.set({ id: a.id, nombre: a.nombre });
    }
  }
  guardarDescripcion() {
    const dm = this.descripcionModal();
    if (!dm || this.guardandoDescripcion()) return;
    const txt = this.textoDescripcion.trim();
    if (!txt) return;
    this.guardandoDescripcion.set(true);
    this.svc.describirArchivo(dm.id, txt).subscribe({
      next: () => {
        this.guardandoDescripcion.set(false);
        this.descripcionModal.set(null);
        this.toast.exito('Descripción guardada');
        this.cargar();
      },
      error: (err) => {
        this.guardandoDescripcion.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }
  accionDescargarArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.descargar(a);
  }
  accionCopiarArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.copiarArchivo(a);
  }
  accionRenombrarArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.abrirEdicion(a);
  }
  accionEliminarArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.pedirEliminar(a);
  }
  accionDescargarCarpeta(ruta: string) {
    this.cerrarMenu();
    this.descargarCarpeta(ruta);
  }
  accionMoverA(tipo: 'archivo' | 'carpeta', ref: string) {
    this.cerrarMenu();
    this.abrirMoverA(tipo, ref);
  }

  descargarCarpeta(ruta: string) {
    this.svc.descargarCarpeta(ruta).subscribe({
      next: (blob) => this.guardarBlob(blob, `${this.nombreHoja(ruta)}.zip`),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Renombrar carpeta ---
  abrirRenombrarCarpeta(ruta: string) {
    this.nombreRenombrar = this.nombreHoja(ruta);
    this.renombrarModal.set({ origen: ruta });
  }
  confirmarRenombrarCarpeta() {
    const rc = this.renombrarModal();
    if (!rc) return;
    const nombre = this.nombreRenombrar.trim();
    if (!nombre) return;
    if (nombre.includes('/')) {
      this.toast.error('El nombre no puede contener "/"');
      return;
    }
    const destino = this.unir(this.padre(rc.origen), nombre);
    this.renombrarModal.set(null);
    this.reubicarCarpeta(rc.origen, destino, 'Carpeta renombrada');
  }

  // --- Mover a… ---
  abrirMoverA(tipo: 'archivo' | 'carpeta', ref: string) {
    this.moverModal.set({ tipo, ref });
  }
  // Carpetas válidas como destino para el elemento del modal "Mover a…".
  destinosMover(): { ruta: string; etiqueta: string }[] {
    const mv = this.moverModal();
    if (!mv) return [];
    const todas = [...new Set<string>(['/', ...this.rutasConocidas()])];
    let validas: string[];
    if (mv.tipo === 'archivo') {
      const actual = this.normalizar(this.archivoPorId(mv.ref)?.carpeta ?? '/');
      validas = todas.filter((r) => r !== actual);
    } else {
      const origen = mv.ref;
      const padreActual = this.padre(origen);
      validas = todas.filter(
        (r) => r !== origen && !r.startsWith(origen + '/') && r !== padreActual,
      );
    }
    return validas
      .sort((a, b) => a.localeCompare(b))
      .map((r) => ({ ruta: r, etiqueta: r === '/' ? 'Mis archivos' : r }));
  }
  confirmarMover(destino: string) {
    const mv = this.moverModal();
    this.moverModal.set(null);
    if (!mv) return;
    if (mv.tipo === 'archivo') this.moverArchivo(mv.ref, destino);
    else this.moverCarpeta(mv.ref, destino);
  }

  // --- Arrastre propio (eventos de puntero) ---
  private readonly UMBRAL = 5; // px que hay que mover para considerar "arrastre"

  iniciarPosibleArrastre(
    ev: PointerEvent,
    tipo: 'archivo' | 'carpeta',
    ref: string,
    nombre: string,
  ) {
    if (ev.button !== 0) return; // solo botón izquierdo
    this.pendiente = { tipo, ref, nombre, x0: ev.clientX, y0: ev.clientY };
    document.body.classList.add('agarrando'); // mano cerrada al pulsar y mantener
  }

  // Resalta el destino bajo el puntero mientras se arrastra.
  enHover(destino: string) {
    if (this.arrastrando()) this.destinoHover.set(destino);
  }
  salirHover(destino: string) {
    // Al salir de una carpeta volvemos al destino por defecto ('..' = padre).
    if (this.arrastrando() && this.destinoHover() === destino) this.destinoHover.set('..');
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(ev: PointerEvent) {
    if (this.arrastrando()) {
      ev.preventDefault();
      this.ghostPos.set({ x: ev.clientX, y: ev.clientY });
      return;
    }
    const p = this.pendiente;
    if (!p) return;
    // ¿Hemos superado el umbral? Entonces empieza el arrastre.
    if (Math.abs(ev.clientX - p.x0) + Math.abs(ev.clientY - p.y0) >= this.UMBRAL) {
      this.arrastrando.set({ tipo: p.tipo, ref: p.ref, nombre: p.nombre });
      this.destinoHover.set('..');
      this.ghostPos.set({ x: ev.clientX, y: ev.clientY });
      document.body.classList.add('arrastrando-archivo');
    }
  }

  @HostListener('document:pointerup')
  onPointerUp() {
    const a = this.arrastrando();
    const p = this.pendiente;
    const dh = this.destinoHover();
    this.finArrastre();
    if (a) {
      // Era un arrastre: mover al destino resuelto.
      if ((dh === '..' || dh === null) && this.rutaActual() === '/') return; // sin padre en la raíz
      const destino = dh === '..' || dh === null ? this.padre(this.rutaActual()) : dh;
      if (a.tipo === 'archivo') this.moverArchivo(a.ref, destino);
      else this.moverCarpeta(a.ref, destino);
    } else if (p && p.tipo === 'carpeta') {
      // Fue un clic simple sobre una carpeta: entrar.
      this.entrar(p.ref);
    } else if (p && p.tipo === 'archivo') {
      // Clic simple sobre un archivo: abrirlo.
      const f = this.archivoPorId(p.ref);
      if (f) this.abrir(f);
    }
  }

  @HostListener('document:pointercancel')
  onPointerCancel() {
    this.finArrastre();
  }

  private finArrastre() {
    this.pendiente = null;
    this.arrastrando.set(null);
    this.destinoHover.set(null);
    document.body.classList.remove('agarrando');
  }

  private moverArchivo(id: string, destino: string) {
    const f = this.todos().find((x) => x.id === id);
    if (f && this.normalizar(f.carpeta) === destino) return; // ya está ahí
    this.svc.actualizar(id, { carpeta: destino }).subscribe({
      next: () => {
        this.toast.exito('Archivo movido');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  protected moverCarpeta(origen: string, destinoPadre: string) {
    const destino = this.unir(destinoPadre, this.nombreHoja(origen));
    this.reubicarCarpeta(origen, destino, 'Carpeta movida');
  }

  // Reubica una carpeta (mover o renombrar): re-prefija la ruta de todos los
  // archivos del subárbol y remapea las carpetas vacías de localStorage.
  private reubicarCarpeta(origen: string, destino: string, mensajeOk: string) {
    if (destino === origen) return;
    if (destino.startsWith(origen + '/')) {
      this.toast.error('No puedes mover una carpeta dentro de sí misma');
      return;
    }
    if (this.rutasConocidas().has(destino)) {
      this.toast.error('Ya existe una carpeta con ese nombre en el destino');
      return;
    }

    const afectados = this.archivosBajo(origen);
    const remapVacias = () => {
      this.carpetas.update((v) =>
        v.map((c) =>
          c.ruta === origen || c.ruta.startsWith(origen + '/')
            ? { ...c, ruta: destino + c.ruta.slice(origen.length) }
            : c,
        ),
      );
      this.svc.reubicarCarpetaApi(origen, destino).subscribe({ error: () => {} });
    };

    if (afectados.length === 0) {
      remapVacias();
      this.toast.exito(mensajeOk);
      return;
    }

    forkJoin(
      afectados.map((a) =>
        this.svc.actualizar(a.id, {
          carpeta: destino + this.normalizar(a.carpeta).slice(origen.length),
        }),
      ),
    ).subscribe({
      next: () => {
        remapVacias();
        this.toast.exito(mensajeOk);
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  pedirBorrarCarpeta(ruta: string) {
    this.confirmacion.set({
      titulo: 'Borrar carpeta',
      mensaje: `¿Mover la carpeta "${this.nombreHoja(ruta)}" y todo su contenido a la papelera?`,
      accion: 'Borrar carpeta',
      onOk: () => this.borrarCarpeta(ruta),
    });
  }
  private borrarCarpeta(ruta: string) {
    const afectados = this.archivosBajo(ruta);
    const limpiar = () => {
      this.carpetas.update((v) => v.filter((c) => c.ruta !== ruta && !c.ruta.startsWith(ruta + '/')));
      this.svc.eliminarCarpetaApi(ruta).subscribe({ error: () => {} });
      // Si estábamos dentro de la carpeta borrada, subimos al padre.
      const act = this.rutaActual();
      if (act === ruta || act.startsWith(ruta + '/')) this.rutaActual.set(this.padre(ruta));
    };

    if (afectados.length === 0) {
      limpiar();
      this.toast.exito('Carpeta borrada');
      return;
    }

    forkJoin(afectados.map((a) => this.svc.eliminar(a.id))).subscribe({
      next: () => {
        limpiar();
        this.toast.exito('Carpeta enviada a la papelera');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  copiarCarpeta(ruta: string) {
    // Destino: misma carpeta padre, con nombre "<nombre> (copia)" único.
    const base = this.unir(this.padre(ruta), this.nombreHoja(ruta) + ' (copia)');
    let destino = base;
    let n = 2;
    while (this.rutasConocidas().has(destino)) {
      destino = `${base} ${n++}`;
    }

    const afectados = this.archivosBajo(ruta);
    const recrearVacias = () => {
      const ahora = new Date().toISOString();
      const remap = this.carpetas()
        .filter((c) => c.ruta === ruta || c.ruta.startsWith(ruta + '/'))
        .map((c) => ({ ruta: destino + c.ruta.slice(ruta.length), creada: c.creada }));
      this.carpetas.update((v) => [...v, { ruta: destino, creada: ahora }, ...remap]);
      // Persistir las carpetas nuevas en el backend.
      forkJoin([destino, ...remap.map((r) => r.ruta)].map((r) => this.svc.crearCarpetaApi(r))).subscribe({
        error: () => {},
      });
    };

    if (afectados.length === 0) {
      recrearVacias();
      this.toast.exito('Carpeta copiada');
      return;
    }

    forkJoin(
      afectados.map((a) =>
        this.svc.copiar(a.id, { carpeta: destino + this.normalizar(a.carpeta).slice(ruta.length) }),
      ),
    ).subscribe({
      next: () => {
        recrearVacias();
        this.toast.exito('Carpeta copiada');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Selección múltiple ---
  // Claves: 'f:<id>' para archivos, 'd:<ruta>' para carpetas.
  protected seleccionados = signal<Set<string>>(new Set());
  protected haySeleccion = computed(() => this.seleccionados().size > 0);
  protected numSeleccionados = computed(() => this.seleccionados().size);
  protected todosSeleccionados = computed(() => {
    const total = this.subcarpetas().length + this.archivosActuales().length;
    return total > 0 && this.seleccionados().size === total;
  });
  protected bulkMoverModal = signal(false);

  protected claveCarpeta(ruta: string) { return `d:${ruta}`; }
  protected claveArchivo(id: string) { return `f:${id}`; }
  protected estaSeleccionado(clave: string): boolean { return this.seleccionados().has(clave); }

  protected toggleSeleccion(ev: Event, clave: string) {
    ev.stopPropagation();
    const s = new Set(this.seleccionados());
    s.has(clave) ? s.delete(clave) : s.add(clave);
    this.seleccionados.set(s);
  }
  protected toggleTodo() {
    if (this.todosSeleccionados()) {
      this.seleccionados.set(new Set());
    } else {
      const s = new Set<string>();
      for (const c of this.subcarpetas()) s.add(this.claveCarpeta(c));
      for (const a of this.archivosActuales()) s.add(this.claveArchivo(a.id));
      this.seleccionados.set(s);
    }
  }
  protected limpiarSeleccion() { this.seleccionados.set(new Set()); }

  protected pedirBorrarSeleccion() {
    const n = this.seleccionados().size;
    this.confirmacion.set({
      titulo: 'Borrar selección',
      mensaje: `¿Mover ${n} elemento${n !== 1 ? 's' : ''} a la papelera?`,
      accion: 'Borrar',
      onOk: () => this.ejecutarBorrarSeleccion(),
    });
  }
  private ejecutarBorrarSeleccion() {
    const sel = [...this.seleccionados()];
    const archIds = sel.filter(k => k.startsWith('f:')).map(k => k.slice(2));
    const carpRutas = sel.filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const n = sel.length;
    const opsArch = archIds.map(id => this.svc.eliminar(id));
    const archsEnCarpetas = carpRutas.flatMap(ruta => this.archivosBajo(ruta));
    const opsCarp = archsEnCarpetas.map(a => this.svc.eliminar(a.id));
    const actualizarCarpetasLocal = () => {
      for (const ruta of carpRutas) {
        this.carpetas.update(v => v.filter(c => c.ruta !== ruta && !c.ruta.startsWith(ruta + '/')));
        const act = this.rutaActual();
        if (act === ruta || act.startsWith(ruta + '/')) this.rutaActual.set(this.padre(ruta));
      }
    };
    // Borra la fila de "carpetas" (carpetas persistidas, aunque ya no estén
    // vacías tras borrar su contenido arriba) DESPUÉS de los archivos, y se
    // espera su respuesta antes de refrescar: si se dispara sin esperar (como
    // antes) y se recarga la lista demasiado pronto, el DELETE puede no haber
    // terminado todavía en el servidor y la carpeta "reaparece" hasta que se
    // repite la acción una segunda vez.
    const borrarCarpetasYTerminar = () => {
      actualizarCarpetasLocal();
      this.limpiarSeleccion();
      this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} enviado${n !== 1 ? 's' : ''} a la papelera`);
      if (carpRutas.length === 0) {
        this.cargar();
        return;
      }
      forkJoin(carpRutas.map(ruta => this.svc.eliminarCarpetaApi(ruta).pipe(catchError(() => of(null)))))
        .subscribe(() => this.cargar());
    };
    const todosArchivos = [...opsArch, ...opsCarp];
    if (todosArchivos.length === 0) {
      borrarCarpetasYTerminar();
      return;
    }
    forkJoin(todosArchivos).subscribe({
      next: () => borrarCarpetasYTerminar(),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  protected ejecutarCopiarSeleccion() {
    const sel = [...this.seleccionados()];
    const archIds = sel.filter(k => k.startsWith('f:')).map(k => k.slice(2));
    const carpRutas = sel.filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const n = sel.length;
    const archivos = archIds.map(id => this.todos().find(a => a.id === id)!).filter(Boolean);
    const opsArch = archivos.map(a =>
      this.svc.copiar(a.id, { carpeta: this.normalizar(a.carpeta), nombre: `${a.nombre} (copia)` })
    );
    for (const ruta of carpRutas) this.copiarCarpeta(ruta);
    if (opsArch.length > 0) {
      forkJoin(opsArch).subscribe({
        next: () => {
          this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} copiado${n !== 1 ? 's' : ''}`);
          this.limpiarSeleccion();
          this.cargar();
        },
        error: (err) => this.toast.error(mensajeError(err)),
      });
    } else {
      this.limpiarSeleccion();
    }
  }

  protected abrirBulkMover() { this.bulkMoverModal.set(true); }

  protected destinosBulkMover(): { ruta: string; etiqueta: string }[] {
    const carpRutas = [...this.seleccionados()].filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const todas = [...new Set<string>(['/', ...this.rutasConocidas()])];
    const validas = todas.filter(r => {
      for (const ruta of carpRutas) {
        if (r === ruta || r.startsWith(ruta + '/')) return false;
      }
      return true;
    });
    return validas.sort().map(r => ({ ruta: r, etiqueta: r === '/' ? 'Mis archivos' : r }));
  }

  protected confirmarBulkMover(destinoPadre: string) {
    this.bulkMoverModal.set(false);
    const sel = [...this.seleccionados()];
    const archIds = sel.filter(k => k.startsWith('f:')).map(k => k.slice(2));
    const carpRutas = sel.filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const n = sel.length;
    const archivos = archIds.map(id => this.todos().find(a => a.id === id)!).filter(Boolean);
    const opsArch = archivos
      .filter(a => this.normalizar(a.carpeta) !== destinoPadre)
      .map(a => this.svc.actualizar(a.id, { carpeta: destinoPadre }));
    for (const ruta of carpRutas) this.moverCarpeta(ruta, destinoPadre);
    if (opsArch.length > 0) {
      forkJoin(opsArch).subscribe({
        next: () => {
          this.toast.exito(`${n} elemento${n !== 1 ? 's' : ''} movido${n !== 1 ? 's' : ''}`);
          this.limpiarSeleccion();
          this.cargar();
        },
        error: (err) => this.toast.error(mensajeError(err)),
      });
    } else {
      this.limpiarSeleccion();
    }
  }

  // Archivos cuyo carpeta es `ruta` o está dentro de su subárbol.
  private archivosBajo(ruta: string): Archivo[] {
    return this.todos().filter((a) => {
      const c = this.normalizar(a.carpeta);
      return c === ruta || c.startsWith(ruta + '/');
    });
  }
}
