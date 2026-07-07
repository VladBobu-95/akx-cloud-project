import {
  Component,
  DestroyRef,
  EventEmitter,
  HostListener,
  Input,
  OnInit,
  Output,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of, map, catchError, finalize } from 'rxjs';
import { marked } from 'marked';
import { ToastService } from '../../core/toast.service';
import { Archivo, ResultadoBusqueda } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';
import { normalizarRuta, unir, padre, nombreHoja } from './rutas.util';
import { FuenteArchivos, OpcionesExplorador, PeticionExportar } from './fuente';
import {
  ACCEPT_ARCHIVOS,
  esTipoPermitido,
  MENSAJE_TIPO_NO_PERMITIDO,
  MAX_ARCHIVO_BYTES,
  MENSAJE_ARCHIVO_GRANDE,
} from '../../shared/tipos-archivo';

// Un elemento arrastrable: un archivo (por id) o una carpeta (por ruta).
interface ItemArrastre {
  tipo: 'archivo' | 'carpeta';
  ref: string;
  nombre: string;
}
// Payload de lo que se está arrastrando: uno o varios elementos (arrastre múltiple).
interface Arrastre {
  items: ItemArrastre[];
}

// Explorador de archivos reutilizable. Lo usan tanto "Mis archivos" (fuente =
// ArchivosService) como "Compartido" (fuente = adaptador de CompartidoService),
// para que ambas vistas sean idénticas. El origen de datos y las diferencias de
// comportamiento (buscador, acciones de IA, papelera vs borrado directo) llegan
// por los inputs `datos` y `opciones`.
@Component({
  selector: 'app-explorador',
  imports: [FormsModule, DatePipe, FileSizePipe],
  templateUrl: './explorador.html',
  styleUrl: './explorador.scss',
})
export class ExploradorComponent implements OnInit {
  @Input({ required: true }) datos!: FuenteArchivos;
  @Input({ required: true }) opciones!: OpcionesExplorador;
  // Emite el nº total de archivos cargados (para que el contenedor lo muestre).
  @Output() totalCambio = new EventEmitter<number>();
  // Mover / copiar elementos a un espacio EXTERNO (personal ↔ compartido). El
  // contenedor recibe la petición ya resuelta (con el destinoId) y hace las llamadas.
  // El arrastre y "Mover a…" emiten `moverAExterno`; "Copiar en…" emite `copiarAExterno`.
  @Output() moverAExterno = new EventEmitter<PeticionExportar>();
  @Output() copiarAExterno = new EventEmitter<PeticionExportar>();

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
  // "Copiar en…": selector de destino que COPIA un archivo (el original se queda).
  // Solo aplica a archivos; el destino puede ser una carpeta del espacio actual o,
  // si hay destino externo (compartido), Mis archivos y sus subcarpetas.
  protected copiarEnModal = signal<{ ref: string } | null>(null);
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
  // true mientras el puntero está sobre la zona de drop del espacio EXTERNO.
  protected sobreExterno = signal(false);
  // Selector que se abre al soltar sobre el espacio externo cuando hay VARIOS
  // destinos posibles (personal → compartido: hay que elegir qué carpeta compartida).
  protected dropExternoModal = signal<{ items: ItemArrastre[] } | null>(null);
  // Etiqueta del "ghost": el nombre si es un solo elemento, o "N elementos" si son varios.
  protected etiquetaArrastre = computed(() => {
    const a = this.arrastrando();
    if (!a) return '';
    return a.items.length === 1 ? a.items[0].nombre : `${a.items.length} elementos`;
  });
  // Candidato de arrastre registrado en pointerdown, antes de superar el umbral.
  private pendiente: { tipo: 'archivo' | 'carpeta'; ref: string; nombre: string; x0: number; y0: number } | null =
    null;

  // El escaneo de facturas va en segundo plano y puede tardar minutos; mientras
  // haya algo en cola, refrescamos solos el listado cada 5s para que "Estado"
  // se actualice sin recargar la página a mano. Se para sola en cuanto no
  // queda nada pendiente/escaneando.
  private hayEscaneoEnCurso = computed(() =>
    this.todos().some(
      (a) =>
        a.estadoEscaneo === 'pendiente' ||
        a.estadoEscaneo === 'escaneando' ||
        a.estadoIndexado === 'pendiente' ||
        a.estadoIndexado === 'indexando',
    ),
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

  // --- Paginación (en cliente) ---
  // Todo el listado ya está en memoria (el árbol se construye en cliente), así
  // que paginamos la vista de la carpeta actual sin tocar el backend. Carpetas y
  // archivos se tratan como UNA secuencia (carpetas primero) que se parte en
  // páginas de PAGE_SIZE filas.
  protected readonly OPCIONES_TAMANO = [10, 15, 20, 50];
  protected tamanoPagina = signal(15);
  protected pagina = signal(0);

  protected totalFilas = computed(() => this.subcarpetas().length + this.archivosActuales().length);
  protected totalPaginas = computed(() => Math.max(1, Math.ceil(this.totalFilas() / this.tamanoPagina())));

  // Rebanada visible en la página actual de la secuencia global [carpetas…, archivos…].
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
  // Cambiar el nº de filas por página: vuelve a la primera para no quedar en una
  // página que ya no existe con el nuevo tamaño.
  protected cambiarTamano(valor: number) {
    this.tamanoPagina.set(valor);
    this.pagina.set(0);
  }
  // Saltar a una página escrita a mano (1-based). Acota a [1, totalPaginas]; ignora
  // texto no numérico o valores < 1.
  protected irAPagina(valor: string | number) {
    const n = Math.trunc(Number(valor));
    if (!Number.isFinite(n) || n < 1) return;
    this.pagina.set(Math.min(n, this.totalPaginas()) - 1);
  }

  constructor() {
    const id = setInterval(() => {
      if (this.hayEscaneoEnCurso()) this.refrescarEstados();
    }, 3000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
    // Si se reduce el nº de filas (borrados) y la página actual queda fuera de
    // rango, la fijamos a la última válida. (Al cambiar de carpeta se resetea a
    // 0 desde los métodos de navegación.)
    effect(() => {
      const tp = this.totalPaginas();
      this.pagina.update((p) => (p > tp - 1 ? tp - 1 : p));
    });
  }

  ngOnInit() {
    this.cargar();
  }

  // Recarga pública: la usa el contenedor tras mover elementos a/desde otro espacio
  // (el origen ya no los tiene y hay que reflejarlo).
  recargar() {
    this.cargar();
  }

  // Refresco silencioso (sin tocar `cargando`, que mostraría "Cargando…" y
  // ocultaría la tabla): solo actualiza los datos de los archivos para que se
  // vea el cambio de estado del escaneo.
  private refrescarEstados() {
    this.datos.listarTodos().subscribe({
      next: (archivos) => {
        this.todos.set(archivos);
        this.totalCambio.emit(archivos.length);
      },
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
  // Fecha del archivo según el campo configurado (subida o última actualización).
  protected fechaArchivo(a: Archivo): string {
    return this.opciones.campoFecha === 'actualizadoEn' ? a.actualizadoEn : a.subidoEn;
  }
  // Fecha de la carpeta. En modo "última actualización" (compartido) = la MÁS
  // RECIENTE de su contenido (o su fecha de creación si está vacía). En modo
  // "subida" (personal) = su fecha de creación o, si no se creó explícitamente, la
  // subida más ANTIGUA de su contenido. null si no hay nada.
  protected fechaCarpeta(ruta: string): string | null {
    if (this.opciones.campoFecha === 'actualizadoEn') {
      const fechas = this.archivosBajo(ruta).map((a) => a.actualizadoEn).filter(Boolean);
      if (fechas.length > 0) return fechas.reduce((max, f) => (f > max ? f : max));
      return this.carpetas().find((c) => c.ruta === ruta)?.creada ?? null;
    }
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
      archivos: this.datos.listarTodos(),
      carpetas: this.datos.listarCarpetas(),
    }).subscribe({
      next: ({ archivos, carpetas }) => {
        this.todos.set(archivos);
        this.carpetas.set(carpetas);
        this.totalCambio.emit(archivos.length);
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
    this.datos.buscarSemantica(q).subscribe({
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
    this.pagina.set(0);
    this.limpiarBusqueda();
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
    this.datos.crearCarpetaApi(ruta).subscribe({
      next: () => {
        this.carpetas.update((v) => [...v, { ruta, creada: new Date().toISOString() }]);
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Subir (un solo clic: se sube a la carpeta actual) ---
  protected readonly ACCEPT_ARCHIVOS = ACCEPT_ARCHIVOS;
  seleccionar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = ''; // permite volver a elegir los mismos archivos
    // Primera criba en cliente: separa por formato no permitido y por tamaño, y
    // avisa. El backend valida además el contenido real (magic bytes) y el tamaño,
    // pero así evitamos subir algo que se va a rechazar y damos un mensaje claro.
    const noPermitidos = files.filter((f) => !esTipoPermitido(f));
    const grandes = files.filter((f) => esTipoPermitido(f) && f.size > MAX_ARCHIVO_BYTES);
    const permitidos = files.filter((f) => esTipoPermitido(f) && f.size <= MAX_ARCHIVO_BYTES);
    if (noPermitidos.length) {
      this.toast.error(`${MENSAJE_TIPO_NO_PERMITIDO} (${noPermitidos.map((f) => f.name).join(', ')})`);
    }
    if (grandes.length) {
      this.toast.error(`${MENSAJE_ARCHIVO_GRANDE} (${grandes.map((f) => f.name).join(', ')})`);
    }
    if (permitidos.length) this.subirVarios(permitidos);
  }
  // Sube varios archivos a la carpeta actual. Cada uno va en su propia petición
  // (el backend acepta uno por subida) y capturamos el error de cada uno para
  // que un fallo no aborte el resto. Al terminar, recarga y muestra un resumen.
  private subirVarios(files: File[]) {
    this.subiendo.set(true);
    this.subidaRestantes.set(files.length);
    const carpeta = this.rutaActual();
    const subidas = files.map((f) =>
      this.datos.subir(f, carpeta).pipe(
        map((archivo) => ({ ok: true as const, archivo, error: null })),
        catchError((err) => of({ ok: false as const, archivo: null, error: mensajeError(err) })),
        finalize(() => this.subidaRestantes.update((n) => n - 1)),
      ),
    );
    forkJoin(subidas).subscribe((resultados) => {
      const ok = resultados.filter((r) => r.ok).length;
      const fallidos = resultados.length - ok;
      // Duplicados (dedup por hash): subidos "ok" pero reutilizados, no nuevos.
      const dups = resultados.filter((r) => r.ok && r.archivo?.duplicado).length;
      const nuevos = ok - dups;
      this.subiendo.set(false);
      this.subidaRestantes.set(0);
      if (fallidos === 0) {
        if (dups > 0 && nuevos === 0) {
          this.toast.exito(
            dups === 1 ? 'Ese archivo ya lo tenías (no se ha duplicado)' : `${dups} ya los tenías (no se duplicaron)`,
          );
        } else if (dups > 0) {
          this.toast.exito(`${nuevos} subido(s); ${dups} ya existían`);
        } else {
          this.toast.exito(nuevos === 1 ? 'Archivo subido' : `${nuevos} archivos subidos`);
        }
      } else {
        // Mensaje específico del backend (p. ej. formato/contenido no permitido).
        // Si todos fallan por la misma razón, mostramos esa; si no, un resumen.
        const errores = [...new Set(resultados.filter((r) => !r.ok && r.error).map((r) => r.error))];
        if (ok === 0 && errores.length === 1) {
          this.toast.error(errores[0]!);
        } else {
          this.toast.error(`${ok} subido(s), ${fallidos} fallaron${errores.length === 1 ? `: ${errores[0]}` : ''}`);
        }
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
      this.datos.descargar(a.id).subscribe({
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
    this.datos.descargar(a.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        if (win) {
          const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const esImagen = /^image\//.test(mimeType);
          const cuerpo = esImagen
            ? `<img src="${url}">`
            : `<iframe src="${url}#zoom=100"></iframe>`;
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
    this.datos.descargar(a.id).subscribe({
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
    this.datos.actualizar(ed.id, { nombre: ed.nombre, carpeta: ed.carpeta }).subscribe({
      next: () => {
        this.toast.exito('Archivo actualizado');
        this.editando.set(null);
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  pedirEliminar(a: Archivo) {
    this.confirmacion.set(
      this.opciones.aPapelera
        ? {
            titulo: 'Mover a la papelera',
            mensaje: `¿Mover "${a.nombre}" a la papelera?`,
            accion: 'Mover a papelera',
            onOk: () => this.eliminar(a),
          }
        : {
            titulo: 'Borrar archivo',
            mensaje: `¿Borrar "${a.nombre}" definitivamente? Afecta a todos los del rol.`,
            accion: 'Borrar',
            onOk: () => this.eliminar(a),
          },
    );
  }
  private eliminar(a: Archivo) {
    this.datos.eliminar(a.id).subscribe({
      next: () => {
        this.toast.exito(this.opciones.aPapelera ? 'Movido a la papelera' : 'Archivo borrado');
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
    this.datos.describirArchivo(dm.id, txt).subscribe({
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
  // Reescaneo manual: por si el auto-escaneo al subir falló o se quiere
  // forzar tras corregir el archivo (ej: una foto borrosa re-subida igual).
  accionEscanear(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (!a) return;
    this.datos.escanearFactura(a.id).subscribe({
      next: () => {
        this.toast.exito('Escaneo en curso…');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  accionDescargarArchivo(id: string) {
    const a = this.archivoPorId(id);
    this.cerrarMenu();
    if (a) this.descargar(a);
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
    this.datos.descargarCarpeta(ruta).subscribe({
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
      .map((r) => ({ ruta: r, etiqueta: r === '/' ? this.opciones.etiquetaRaiz : r }));
  }
  confirmarMover(destino: string) {
    const mv = this.moverModal();
    this.moverModal.set(null);
    if (!mv) return;
    if (mv.tipo === 'archivo') this.moverArchivo(mv.ref, destino);
    else this.moverCarpeta(mv.ref, destino);
  }
  // "Mover a…" hacia un espacio externo: MUEVE (el original desaparece del origen).
  confirmarMoverExterno(destinoId: string | null, ruta: string) {
    const mv = this.moverModal();
    this.moverModal.set(null);
    if (!mv) return;
    const nombre = mv.tipo === 'archivo' ? this.archivoPorId(mv.ref)?.nombre ?? '' : this.nombreHoja(mv.ref);
    this.emitirExportacion([{ tipo: mv.tipo, ref: mv.ref, nombre }], destinoId, ruta, 'mover');
  }

  // --- Copiar en… (copia a un destino elegido; el original permanece) ---
  accionCopiarEn(id: string) {
    this.cerrarMenu();
    this.copiarEnModal.set({ ref: id });
  }
  // Destinos INTERNOS: cualquier carpeta del espacio actual (incluida la actual, que
  // equivale a duplicar en el sitio). Se ofrecen todas porque copiar no tiene la
  // restricción de "no a la misma carpeta" que sí tiene mover.
  destinosCopiar(): { ruta: string; etiqueta: string }[] {
    return [...new Set<string>(['/', ...this.rutasConocidas()])]
      .sort((a, b) => a.localeCompare(b))
      .map((r) => ({ ruta: r, etiqueta: r === '/' ? this.opciones.etiquetaRaiz : r }));
  }
  // Destinos EXTERNOS (solo si hay destinoExterno): por cada espacio externo (una o
  // varias carpetas compartidas, o Mis archivos) su raíz + sus subcarpetas. Cada
  // entrada lleva el `destinoId` del espacio (ccId, o null para Mis archivos).
  destinosExternos(): { destinoId: string | null; ruta: string; etiqueta: string }[] {
    const ext = this.opciones.destinoExterno;
    if (!ext) return [];
    const out: { destinoId: string | null; ruta: string; etiqueta: string }[] = [];
    for (const d of ext.destinos) {
      out.push({ destinoId: d.id, ruta: '/', etiqueta: d.etiqueta });
      for (const r of d.carpetas ?? []) {
        out.push({ destinoId: d.id, ruta: r, etiqueta: `${d.etiqueta} › ${r.replace(/^\//, '')}` });
      }
    }
    return out;
  }
  confirmarCopiarEn(destino: string) {
    const ce = this.copiarEnModal();
    this.copiarEnModal.set(null);
    if (!ce) return;
    // Sin `nombre`: el backend conserva el nombre original y solo añade "(copia)"
    // si ya existe en el destino (p. ej. al copiar en la misma carpeta).
    this.datos.copiar(ce.ref, { carpeta: destino }).subscribe({
      next: () => {
        this.toast.exito('Archivo copiado');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
  // "Copiar en…" hacia un espacio externo: COPIA (el original permanece).
  confirmarCopiarEnExterno(destinoId: string | null, ruta: string) {
    const ce = this.copiarEnModal();
    this.copiarEnModal.set(null);
    if (!ce) return;
    const nombre = this.archivoPorId(ce.ref)?.nombre ?? '';
    this.emitirExportacion([{ tipo: 'archivo', ref: ce.ref, nombre }], destinoId, ruta, 'copiar');
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
      this.detectarDestinoExterno(ev);
      return;
    }
    const p = this.pendiente;
    if (!p) return;
    // ¿Hemos superado el umbral? Entonces empieza el arrastre.
    if (Math.abs(ev.clientX - p.x0) + Math.abs(ev.clientY - p.y0) >= this.UMBRAL) {
      this.arrastrando.set({ items: this.itemsArrastre(p) });
      this.destinoHover.set('..');
      this.ghostPos.set({ x: ev.clientX, y: ev.clientY });
      document.body.classList.add('arrastrando-archivo');
    }
  }

  // Si el explorador tiene un espacio externo, detecta cuándo el puntero está sobre su
  // zona de drop (el botón [dropAttr]) para soltar allí (MOVER al otro espacio).
  private detectarDestinoExterno(ev: PointerEvent) {
    const ext = this.opciones.destinoExterno;
    if (!ext) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const sobre = !!el?.closest(`[${ext.dropAttr}]`);
    if (sobre !== this.sobreExterno()) {
      this.sobreExterno.set(sobre);
      document.body.classList.toggle('sobre-externo', sobre);
    }
  }

  // Elementos que representa el arrastre: si la fila iniciadora forma parte de una
  // selección múltiple, se arrastra TODA la selección; si no, solo esa fila.
  private itemsArrastre(p: { tipo: 'archivo' | 'carpeta'; ref: string; nombre: string }): ItemArrastre[] {
    const clave = p.tipo === 'archivo' ? this.claveArchivo(p.ref) : this.claveCarpeta(p.ref);
    const sel = this.seleccionados();
    if (sel.size > 1 && sel.has(clave)) return this.itemsDesdeClaves([...sel]);
    return [{ tipo: p.tipo, ref: p.ref, nombre: p.nombre }];
  }

  // Convierte claves de selección ('f:<id>' / 'd:<ruta>') en elementos arrastrables.
  private itemsDesdeClaves(claves: string[]): ItemArrastre[] {
    return claves.map((k) =>
      k.startsWith('f:')
        ? { tipo: 'archivo' as const, ref: k.slice(2), nombre: this.archivoPorId(k.slice(2))?.nombre ?? '' }
        : { tipo: 'carpeta' as const, ref: k.slice(2), nombre: this.nombreHoja(k.slice(2)) },
    );
  }

  @HostListener('document:pointerup')
  onPointerUp() {
    const a = this.arrastrando();
    const p = this.pendiente;
    const dh = this.destinoHover();
    const sobreExterno = this.sobreExterno();
    this.finArrastre();
    if (a) {
      // ¿Soltado sobre la zona del espacio externo? → MOVER al otro espacio.
      if (sobreExterno && this.opciones.destinoExterno) {
        this.soltarEnExterno(a.items);
        return;
      }
      // Era un arrastre normal: mover al destino resuelto.
      if ((dh === '..' || dh === null) && this.rutaActual() === '/') return; // sin padre en la raíz
      const destino = dh === '..' || dh === null ? this.padre(this.rutaActual()) : dh;
      if (a.items.length === 1) {
        const it = a.items[0];
        if (it.tipo === 'archivo') this.moverArchivo(it.ref, destino);
        else this.moverCarpeta(it.ref, destino);
      } else {
        this.moverItems(a.items, destino);
      }
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
    this.sobreExterno.set(false);
    document.body.classList.remove('agarrando');
    document.body.classList.remove('arrastrando-archivo');
    document.body.classList.remove('sobre-externo');
  }

  // Soltado sobre el espacio externo (MOVER). Si hay un único destino posible
  // (compartido → Mis archivos), se mueve a su raíz directamente; si hay varios
  // (personal → varias carpetas compartidas), se abre un selector para elegir.
  private soltarEnExterno(items: ItemArrastre[]) {
    const destinos = this.opciones.destinoExterno!.destinos;
    if (destinos.length === 1) {
      this.emitirExportacion(items, destinos[0].id, '/', 'mover');
    } else if (destinos.length > 1) {
      this.dropExternoModal.set({ items });
    }
  }
  // El usuario eligió a qué espacio externo mover (desde el selector del arrastre).
  confirmarDropExterno(destinoId: string | null) {
    const d = this.dropExternoModal();
    this.dropExternoModal.set(null);
    if (d) this.emitirExportacion(d.items, destinoId, '/', 'mover');
  }

  private moverArchivo(id: string, destino: string) {
    const f = this.todos().find((x) => x.id === id);
    if (f && this.normalizar(f.carpeta) === destino) return; // ya está ahí
    this.datos.actualizar(id, { carpeta: destino }).subscribe({
      next: () => {
        this.toast.exito('Archivo movido');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // Mueve varios elementos a la vez a una carpeta destino (arrastre múltiple). Las
  // carpetas se reubican una a una (cada reubicación valida ciclos); los archivos
  // se agrupan en un forkJoin para un único refresco y un toast de resumen.
  private moverItems(items: ItemArrastre[], destino: string) {
    for (const c of items.filter((i) => i.tipo === 'carpeta')) this.moverCarpeta(c.ref, destino);
    const ops = items
      .filter((i) => i.tipo === 'archivo')
      .map((i) => this.todos().find((a) => a.id === i.ref))
      .filter((a): a is Archivo => !!a && this.normalizar(a.carpeta) !== destino)
      .map((a) => this.datos.actualizar(a.id, { carpeta: destino }));
    if (ops.length === 0) return;
    forkJoin(ops).subscribe({
      next: () => {
        this.toast.exito(`${ops.length} elemento${ops.length !== 1 ? 's' : ''} movido${ops.length !== 1 ? 's' : ''}`);
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Mover/copiar a un espacio externo (personal ↔ compartido) ---
  // `modo` decide qué output se emite: 'mover' (arrastre y "Mover a…") o 'copiar'
  // ("Copiar en…"). `destinoId` = ccId o null (Mis archivos); `baseExterna` = carpeta.
  private emitirExportacion(
    items: ItemArrastre[],
    destinoId: string | null,
    baseExterna: string,
    modo: 'mover' | 'copiar',
  ) {
    const peticion = this.construirExportacion(items, destinoId, baseExterna);
    if (peticion.archivos.length === 0 && peticion.carpetasVacias.length === 0) return;
    (modo === 'mover' ? this.moverAExterno : this.copiarAExterno).emit(peticion);
    // Al MOVER una carpeta a otro espacio, su metadata de origen debe desaparecer
    // (sus archivos ya se reasignan en el backend). Se borra SOLO la metadata
    // (`soloMeta`): un borrado normal mandaría sus archivos a la papelera, que en
    // paralelo con el move haría que el archivo desapareciera en vez de moverse. Si
    // el move fallara, la carpeta reaparece igualmente (se deriva de esos archivos).
    if (modo === 'mover') {
      for (const it of items) {
        if (it.tipo !== 'carpeta') continue;
        this.carpetas.update((v) => v.filter((c) => c.ruta !== it.ref && !c.ruta.startsWith(it.ref + '/')));
        this.datos.eliminarCarpetaApi(it.ref, true).subscribe({ error: () => {} });
      }
    }
    this.limpiarSeleccion();
  }

  // Traduce los elementos a rutas destino relativas a la raíz del destino: los
  // archivos sueltos van a la raíz ("/"); una carpeta se recrea en la raíz
  // conservando su subárbol (archivos y subcarpetas vacías). Misma lógica de remap
  // que copiarCarpeta, pero hacia otro espacio.
  private construirExportacion(
    items: ItemArrastre[],
    destinoId: string | null,
    baseExterna = '/',
  ): PeticionExportar {
    // Prefijo de la carpeta destino en el espacio externo ('' si es la raíz, o
    // p. ej. '/facturas' para copiar dentro de esa subcarpeta de Mis archivos).
    const raiz = this.normalizar(baseExterna);
    const pref = raiz === '/' ? '' : raiz;
    const archivos: { id: string; carpetaDestino: string }[] = [];
    const vacias = new Set<string>();
    for (const it of items) {
      if (it.tipo === 'archivo') {
        archivos.push({ id: it.ref, carpetaDestino: raiz });
        continue;
      }
      const ruta = it.ref;
      const base = pref + '/' + this.nombreHoja(ruta);
      for (const a of this.archivosBajo(ruta)) {
        const rel = this.normalizar(a.carpeta).slice(ruta.length); // '' o '/sub...'
        archivos.push({ id: a.id, carpetaDestino: base + rel || '/' });
      }
      vacias.add(base);
      for (const c of this.carpetas()) {
        if (c.ruta.startsWith(ruta + '/')) vacias.add(base + c.ruta.slice(ruta.length));
      }
    }
    return { destinoId, archivos, carpetasVacias: [...vacias] };
  }

  protected moverCarpeta(origen: string, destinoPadre: string) {
    const destino = this.unir(destinoPadre, this.nombreHoja(origen));
    this.reubicarCarpeta(origen, destino, 'Carpeta movida');
  }

  // Reubica una carpeta (mover o renombrar). Una sola llamada atómica al
  // servidor (mueve metadata + contenido en la misma operación).
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
    this.datos.reubicarCarpetaApi(origen, destino).subscribe({
      next: () => {
        this.toast.exito(mensajeOk);
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  pedirBorrarCarpeta(ruta: string) {
    const hoja = this.nombreHoja(ruta);
    this.confirmacion.set({
      titulo: 'Borrar carpeta',
      mensaje: this.opciones.aPapelera
        ? `¿Mover la carpeta "${hoja}" y todo su contenido a la papelera?`
        : `¿Borrar la carpeta "${hoja}" y todo su contenido? Afecta a todos los del rol.`,
      accion: 'Borrar carpeta',
      onOk: () => this.borrarCarpeta(ruta),
    });
  }
  private borrarCarpeta(ruta: string) {
    const afectados = this.archivosBajo(ruta);
    // Actualiza el árbol local y, si estábamos dentro de la carpeta borrada, sube al padre.
    const limpiarLocal = () => {
      this.carpetas.update((v) => v.filter((c) => c.ruta !== ruta && !c.ruta.startsWith(ruta + '/')));
      const act = this.rutaActual();
      if (act === ruta || act.startsWith(ruta + '/')) this.rutaActual.set(this.padre(ruta));
    };
    // Borra la metadata de la carpeta y se espera su respuesta antes de refrescar
    // (si no, el DELETE puede no haber terminado y la carpeta "reaparece" vacía en
    // Mis archivos aunque sus archivos ya se hayan ido a la papelera).
    const borrarMetaYRefrescar = () => {
      limpiarLocal();
      this.toast.exito(
        afectados.length > 0 && this.opciones.aPapelera ? 'Carpeta enviada a la papelera' : 'Carpeta borrada',
      );
      this.datos.eliminarCarpetaApi(ruta).pipe(catchError(() => of(null))).subscribe(() => this.cargar());
    };

    if (afectados.length === 0) {
      borrarMetaYRefrescar();
      return;
    }

    forkJoin(afectados.map((a) => this.datos.eliminar(a.id))).subscribe({
      next: () => borrarMetaYRefrescar(),
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
      forkJoin([destino, ...remap.map((r) => r.ruta)].map((r) => this.datos.crearCarpetaApi(r))).subscribe({
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
        this.datos.copiar(a.id, { carpeta: destino + this.normalizar(a.carpeta).slice(ruta.length) }),
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
  // "Seleccionar todo" se limita a lo que se ve en la página actual.
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
    const claves = this.clavesPaginaActual();
    const s = new Set(this.seleccionados());
    if (this.todosSeleccionados()) {
      for (const k of claves) s.delete(k);
    } else {
      for (const k of claves) s.add(k);
    }
    this.seleccionados.set(s);
  }
  protected limpiarSeleccion() { this.seleccionados.set(new Set()); }

  protected pedirBorrarSeleccion() {
    const n = this.seleccionados().size;
    this.confirmacion.set({
      titulo: 'Borrar selección',
      mensaje: this.opciones.aPapelera
        ? `¿Mover ${n} elemento${n !== 1 ? 's' : ''} a la papelera?`
        : `¿Borrar ${n} elemento${n !== 1 ? 's' : ''} definitivamente? Afecta a todos los del rol.`,
      accion: 'Borrar',
      onOk: () => this.ejecutarBorrarSeleccion(),
    });
  }
  private ejecutarBorrarSeleccion() {
    const sel = [...this.seleccionados()];
    const archIds = sel.filter(k => k.startsWith('f:')).map(k => k.slice(2));
    const carpRutas = sel.filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const n = sel.length;
    const opsArch = archIds.map(id => this.datos.eliminar(id));
    const archsEnCarpetas = carpRutas.flatMap(ruta => this.archivosBajo(ruta));
    const opsCarp = archsEnCarpetas.map(a => this.datos.eliminar(a.id));
    const actualizarCarpetasLocal = () => {
      for (const ruta of carpRutas) {
        this.carpetas.update(v => v.filter(c => c.ruta !== ruta && !c.ruta.startsWith(ruta + '/')));
        const act = this.rutaActual();
        if (act === ruta || act.startsWith(ruta + '/')) this.rutaActual.set(this.padre(ruta));
      }
    };
    // Borra la metadata de las carpetas DESPUÉS de los archivos, y se espera su
    // respuesta antes de refrescar (si no, el DELETE puede no haber terminado y la
    // carpeta "reaparece" hasta repetir la acción).
    const mensajeOk = this.opciones.aPapelera
      ? `${n} elemento${n !== 1 ? 's' : ''} enviado${n !== 1 ? 's' : ''} a la papelera`
      : `${n} elemento${n !== 1 ? 's' : ''} borrado${n !== 1 ? 's' : ''}`;
    const borrarCarpetasYTerminar = () => {
      actualizarCarpetasLocal();
      this.limpiarSeleccion();
      this.toast.exito(mensajeOk);
      if (carpRutas.length === 0) {
        this.cargar();
        return;
      }
      forkJoin(carpRutas.map(ruta => this.datos.eliminarCarpetaApi(ruta).pipe(catchError(() => of(null)))))
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
      this.datos.copiar(a.id, { carpeta: this.normalizar(a.carpeta), nombre: `${a.nombre} (copia)` })
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
    return validas.sort().map(r => ({ ruta: r, etiqueta: r === '/' ? this.opciones.etiquetaRaiz : r }));
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
      .map(a => this.datos.actualizar(a.id, { carpeta: destinoPadre }));
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

  // Mover la selección a un espacio externo (MUEVE al otro espacio).
  protected confirmarBulkMoverExterno(destinoId: string | null, ruta: string) {
    this.bulkMoverModal.set(false);
    this.emitirExportacion(this.itemsDesdeClaves([...this.seleccionados()]), destinoId, ruta, 'mover');
  }

  // Archivos cuyo carpeta es `ruta` o está dentro de su subárbol.
  private archivosBajo(ruta: string): Archivo[] {
    return this.todos().filter((a) => {
      const c = this.normalizar(a.carpeta);
      return c === ruta || c.startsWith(ruta + '/');
    });
  }
}
