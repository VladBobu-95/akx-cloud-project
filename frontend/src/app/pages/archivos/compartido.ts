import { Component, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Observable, of, throwError, forkJoin, map, catchError } from 'rxjs';
import { CompartidoService, CarpetaCompartidaAccesible } from '../../core/compartido.service';
import { ArchivosService } from '../../core/archivos.service';
import { ToastService } from '../../core/toast.service';
import { ResultadoBusqueda } from '../../core/models';
import { mensajeError } from '../../shared/errores';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { ExploradorComponent } from './explorador';
import { FuenteArchivos, OpcionesExplorador, PeticionExportar } from './fuente';

// Adaptador: envuelve CompartidoService (fijado a una carpeta compartida) con la
// MISMA interfaz que ArchivosService, para que ExploradorComponent trate las
// carpetas compartidas exactamente igual que "Mis archivos".
class FuenteCompartida implements FuenteArchivos {
  constructor(private svc: CompartidoService, private ccId: string) {}
  listarTodos() { return this.svc.listarTodos(this.ccId); }
  listarCarpetas() { return this.svc.listarCarpetas(this.ccId); }
  crearCarpetaApi(ruta: string) { return this.svc.crearCarpeta(this.ccId, ruta); }
  reubicarCarpetaApi(origen: string, destino: string) {
    return this.svc.reubicarCarpeta(this.ccId, origen, destino);
  }
  eliminarCarpetaApi(ruta: string) { return this.svc.eliminarCarpeta(this.ccId, ruta); }
  subir(file: File, carpeta?: string) { return this.svc.subir(this.ccId, file, carpeta); }
  descargar(id: string) { return this.svc.descargar(id); }
  descargarCarpeta(ruta: string) { return this.svc.descargarCarpeta(this.ccId, ruta); }
  actualizar(id: string, datos: { nombre?: string; carpeta?: string }) {
    return this.svc.actualizarArchivo(id, datos);
  }
  copiar(id: string, datos: { carpeta?: string; nombre?: string }) {
    return this.svc.copiarArchivo(id, datos);
  }
  eliminar(id: string) { return this.svc.eliminarArchivo(id); }
  // No aplican a compartido (soportaIA=false); no se llaman.
  describirArchivo(): Observable<never> {
    return throwError(() => new Error('No disponible en carpetas compartidas'));
  }
  escanearFactura(): Observable<never> {
    return throwError(() => new Error('No disponible en carpetas compartidas'));
  }
  // Búsqueda semántica acotada a ESTA carpeta compartida (mismo buscador que
  // "Mis archivos", pero solo sobre su contenido).
  buscarSemantica(q: string): Observable<ResultadoBusqueda[]> {
    return this.svc.buscarSemantica(this.ccId, q);
  }
}

// Vista de carpetas COMPARTIDAS por rol (se muestra en "Mis archivos" con el
// toggle Compartido). Primero se elige un espacio compartido y, dentro, se usa el
// mismo explorador que los archivos personales (almacenamiento único por rol).
@Component({
  selector: 'app-compartido',
  imports: [ExploradorComponent, DatePipe, FileSizePipe],
  template: `
    @if (carpeta() === null) {
      @if (carpetas().length === 0) {
        <div class="card empty">
          <div class="icon">📁</div>
          No tienes carpetas compartidas. El administrador puede crearlas y darte acceso por rol.
        </div>
      } @else {
        <!-- Cada carpeta compartida se ve como una fila con su tamaño total y la
             fecha/hora de su última actualización (subida más reciente). -->
        <div class="card list">
          <table class="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th class="col-tamano">Tamaño</th>
                <th class="col-actualizado">Última actualización</th>
              </tr>
            </thead>
            <tbody>
              @for (c of carpetas(); track c.id) {
                <tr class="fila-carpeta" (click)="abrir(c)">
                  <td class="nombre">📁 {{ c.nombre }}</td>
                  <td class="col-tamano muted">{{ c.tamano ? (c.tamano | fileSize) : '—' }}</td>
                  <td class="col-actualizado muted">
                    {{ c.actualizado ? (c.actualizado | date: 'dd/MM/yy HH:mm') : '—' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    } @else {
      <div class="back-bar">
        <button class="btn-back" (click)="volver()" title="Volver a las carpetas compartidas">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
          >
            <path d="M19 12H5M5 12l7 7M5 12l7-7" />
          </svg>
        </button>
        <span class="back-label">Volver</span>
      </div>

      <app-explorador
        [datos]="fuente()!"
        [opciones]="opciones()!"
        (totalCambio)="total.set($event)"
        (moverAExterno)="exportarAPersonal($event, 'mover')"
        (copiarAExterno)="exportarAPersonal($event, 'copiar')"
      />
    }
  `,
  styles: [`
    .card.list { padding: 0; overflow: hidden; }
    .fila-carpeta { cursor: pointer; }
    .fila-carpeta:hover { background: rgba(148, 163, 184, 0.16); }
    .fila-carpeta .nombre { font-weight: 600; }
    /* Mismos anchos/alineación de columnas que el explorador de Mis archivos. */
    .col-tamano { width: 120px; }
    .col-actualizado { width: 170px; white-space: nowrap; }
    /* Mismo "Volver" que el explorador de Mis archivos (flecha + etiqueta). */
    .back-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .btn-back {
      display: inline-flex; align-items: center; justify-content: center;
      width: 48px; height: 48px;
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--bg); color: var(--green-dark); cursor: pointer;
    }
    .btn-back:hover { background: var(--surface); border-color: var(--green); }
    .back-label { font-weight: 700; font-size: 1.05rem; }
  `],
})
export class CompartidoComponent {
  private svc = inject(CompartidoService);
  private archivos = inject(ArchivosService);
  private toast = inject(ToastService);

  // Referencia al explorador para poder recargarlo tras un MOVER (el original sale
  // del compartido). En 'copiar' no hace falta: el original permanece.
  private explorador = viewChild(ExploradorComponent);

  protected carpetas = signal<CarpetaCompartidaAccesible[]>([]);
  protected carpeta = signal<{ id: string; nombre: string } | null>(null);
  protected total = signal(0);
  // Carpetas del espacio PERSONAL, para ofrecerlas como destino en "Copiar en…"
  // (copiar un archivo compartido a una subcarpeta concreta de Mis archivos).
  private carpetasPersonales = signal<string[]>([]);

  // Origen de datos y opciones del explorador para la carpeta seleccionada.
  protected fuente = signal<FuenteArchivos | null>(null);
  protected opciones = signal<OpcionesExplorador | null>(null);

  constructor() {
    this.cargarCarpetas();
    this.archivos.listarCarpetas().subscribe({
      next: (cs) => this.carpetasPersonales.set(cs.map((c) => c.ruta)),
      error: () => {}, // si falla, "Copiar en…" ofrecerá solo la raíz de Mis archivos
    });
  }

  cargarCarpetas() {
    this.svc.accesibles().subscribe({
      next: (c) => this.carpetas.set(c),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  abrir(c: { id: string; nombre: string }) {
    this.total.set(0);
    this.fuente.set(new FuenteCompartida(this.svc, c.id));
    this.opciones.set({
      etiquetaRaiz: c.nombre,
      soportaBusqueda: true, // buscador acotado a esta carpeta compartida (solo su contenido)
      soportaIA: false, // los compartidos se indexan solos; no se escanean a analítica
      aPapelera: false, // los compartidos se borran definitivamente (afecta a todos)
      mostrarEstado: false, // el estado de indexado no aporta al usuario en compartido
      etiquetaFecha: 'Última actualización',
      campoFecha: 'actualizadoEn', // mostrar la última modificación, no la subida
      // Mover (arrastre / "Mover a…") y copiar ("Copiar en…") al espacio personal.
      // Un único destino: Mis archivos (id null) + sus subcarpetas.
      destinoExterno: {
        etiqueta: 'Mis archivos',
        dropAttr: 'data-drop-personal',
        destinos: [{ id: null, etiqueta: 'Mis archivos', carpetas: this.carpetasPersonales() }],
      },
    });
    this.carpeta.set(c);
  }

  volver() {
    this.carpeta.set(null);
    this.fuente.set(null);
    this.opciones.set(null);
  }

  // Mover o copiar archivos/carpetas compartidos al espacio PERSONAL (arrastre sobre
  // "Personales", o "Mover a…"/"Copiar en…"). En 'mover' el original DESAPARECE del
  // compartido (afecta a todos los del rol); en 'copiar' permanece. Cada archivo lleva
  // su ruta destino ya resuelta por el explorador; las subcarpetas vacías se recrean.
  // Dedup por hash en el backend (campo `duplicado`).
  exportarAPersonal(pet: PeticionExportar, modo: 'mover' | 'copiar') {
    // Carpetas vacías primero, de menos a más profundas (padres antes que hijas).
    const crearOps = [...pet.carpetasVacias]
      .sort((a, b) => a.length - b.length)
      .map((r) =>
        this.archivos.crearCarpetaApi(r).pipe(
          map(() => 'carpeta' as const),
          catchError(() => of('error' as const)),
        ),
      );
    const llamada = (id: string, carpeta: string) =>
      modo === 'mover' ? this.svc.moverAPersonal(id, carpeta) : this.svc.copiarAPersonal(id, carpeta);
    const fileOps = pet.archivos.map((a) =>
      llamada(a.id, a.carpetaDestino).pipe(
        map((res) => (res.duplicado ? ('dup' as const) : ('nuevo' as const))),
        catchError(() => of('error' as const)),
      ),
    );
    const ops = [...crearOps, ...fileOps];
    if (ops.length === 0) return;

    const verbo = modo === 'mover' ? 'movido' : 'copiado';
    const verbos = modo === 'mover' ? 'movidos' : 'copiados';
    forkJoin(ops).subscribe((resultados) => {
      const nuevos = resultados.filter((r) => r === 'nuevo').length;
      const dups = resultados.filter((r) => r === 'dup').length;
      const fallidos = resultados.filter((r) => r === 'error').length;
      if (fallidos > 0) {
        this.toast.error(
          nuevos + dups === 0
            ? `No se pudo ${modo} a Mis archivos`
            : `${nuevos} ${verbo}(s) a Mis archivos, ${fallidos} fallaron`,
        );
      } else if (nuevos === 0 && dups > 0) {
        this.toast.exito(dups === 1 ? 'Ya lo tenías en Mis archivos' : `${dups} ya los tenías en Mis archivos`);
      } else if (dups > 0) {
        this.toast.exito(`${nuevos} ${verbo}(s) a Mis archivos; ${dups} ya los tenías`);
      } else {
        this.toast.exito(nuevos === 1 ? `${verbo[0].toUpperCase()}${verbo.slice(1)} a Mis archivos` : `${nuevos} ${verbos} a Mis archivos`);
      }
      // Al mover, el explorador de compartido debe refrescar (el original ya no está).
      if (modo === 'mover') this.explorador()?.recargar();
    });
  }
}
