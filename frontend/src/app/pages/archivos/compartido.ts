import { Component, inject, signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { CompartidoService } from '../../core/compartido.service';
import { ToastService } from '../../core/toast.service';
import { ResultadoBusqueda } from '../../core/models';
import { mensajeError } from '../../shared/errores';
import { ExploradorComponent } from './explorador';
import { FuenteArchivos, OpcionesExplorador } from './fuente';

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
  // No aplican a compartido (soportaIA=false, soportaBusqueda=false); no se llaman.
  describirArchivo(): Observable<never> {
    return throwError(() => new Error('No disponible en carpetas compartidas'));
  }
  escanearFactura(): Observable<never> {
    return throwError(() => new Error('No disponible en carpetas compartidas'));
  }
  buscarSemantica(): Observable<ResultadoBusqueda[]> {
    return of([]);
  }
}

// Vista de carpetas COMPARTIDAS por rol (se muestra en "Mis archivos" con el
// toggle Compartido). Primero se elige un espacio compartido y, dentro, se usa el
// mismo explorador que los archivos personales (almacenamiento único por rol).
@Component({
  selector: 'app-compartido',
  imports: [ExploradorComponent],
  template: `
    @if (carpeta() === null) {
      @if (carpetas().length === 0) {
        <div class="card empty">
          <div class="icon">📁</div>
          No tienes carpetas compartidas. El administrador puede crearlas y darte acceso por rol.
        </div>
      } @else {
        <div class="card list">
          <table class="table">
            <thead>
              <tr><th>Nombre</th></tr>
            </thead>
            <tbody>
              @for (c of carpetas(); track c.id) {
                <tr class="fila-carpeta" (click)="abrir(c)" style="cursor:pointer">
                  <td class="nombre">📁 {{ c.nombre }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    } @else {
      <div class="row barra">
        <button class="btn btn-ghost btn-sm" (click)="volver()">← Compartido</button>
        <span class="ruta">{{ carpeta()!.nombre }}</span>
        <span class="spacer"></span>
        <span class="muted">{{ total() }} archivo(s)</span>
      </div>

      <app-explorador
        [datos]="fuente()!"
        [opciones]="opciones()!"
        (totalCambio)="total.set($event)"
      />
    }
  `,
  styles: [`
    .card.list { padding: 0; overflow: hidden; }
    .fila-carpeta:hover { background: var(--green-soft); }
    .barra { align-items: center; gap: 10px; margin-bottom: 12px; }
    .barra .ruta { font-weight: 700; font-size: 1.05rem; }
    .barra .spacer { flex: 1; }
  `],
})
export class CompartidoComponent {
  private svc = inject(CompartidoService);
  private toast = inject(ToastService);

  protected carpetas = signal<{ id: string; nombre: string }[]>([]);
  protected carpeta = signal<{ id: string; nombre: string } | null>(null);
  protected total = signal(0);

  // Origen de datos y opciones del explorador para la carpeta seleccionada.
  protected fuente = signal<FuenteArchivos | null>(null);
  protected opciones = signal<OpcionesExplorador | null>(null);

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
    this.total.set(0);
    this.fuente.set(new FuenteCompartida(this.svc, c.id));
    this.opciones.set({
      etiquetaRaiz: c.nombre,
      soportaBusqueda: false, // la búsqueda semántica del chat es personal
      soportaIA: false, // los compartidos se indexan solos; no se escanean a analítica
      aPapelera: false, // los compartidos se borran definitivamente (afecta a todos)
    });
    this.carpeta.set(c);
  }

  volver() {
    this.carpeta.set(null);
    this.fuente.set(null);
    this.opciones.set(null);
  }
}
