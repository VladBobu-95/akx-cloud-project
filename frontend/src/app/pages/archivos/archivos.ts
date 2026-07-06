import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { forkJoin, of, map, catchError } from 'rxjs';
import { ArchivosService } from '../../core/archivos.service';
import { CompartidoService, CarpetaCompartidaAccesible } from '../../core/compartido.service';
import { ToastService } from '../../core/toast.service';
import { ExploradorComponent } from './explorador';
import { CompartidoComponent } from './compartido';
import { OpcionesExplorador, PeticionExportar } from './fuente';

// Página "Mis archivos": cabecera + toggle Personales/Compartido. El explorador en
// sí (tabla, carpetas, drag&drop, menú contextual…) vive en ExploradorComponent y
// se reutiliza tal cual en Compartido — así ambas vistas son idénticas.
@Component({
  selector: 'app-archivos',
  imports: [ExploradorComponent, CompartidoComponent],
  templateUrl: './archivos.html',
  styleUrl: './archivos.scss',
})
export class ArchivosPage {
  // Fuente de datos del explorador personal: el propio ArchivosService cumple la
  // interfaz FuenteArchivos, así que se pasa directamente.
  protected svc = inject(ArchivosService);
  private compartido = inject(CompartidoService);
  private toast = inject(ToastService);

  // Personales (explorador de siempre) vs Compartido (carpetas por rol).
  protected ambito = signal<'personal' | 'compartido'>('personal');

  // Nº total de archivos personales (lo emite el explorador al cargar).
  protected total = signal(0);

  // Referencia al explorador personal para recargarlo tras MOVER a compartido (el
  // original sale de Mis archivos). En 'copiar' no hace falta: el original permanece.
  private explorador = viewChild(ExploradorComponent);

  // Carpetas compartidas accesibles: destinos externos del explorador personal
  // (mover/copiar a Compartido). Cada una es un destino con su id (ccId).
  private compartidas = signal<CarpetaCompartidaAccesible[]>([]);

  constructor() {
    this.compartido.accesibles().subscribe({
      next: (cs) => this.compartidas.set(cs),
      error: () => {}, // si falla, el explorador personal no ofrece destino Compartido
    });
  }

  // Opciones del explorador personal. `destinoExterno` se rellena con las carpetas
  // compartidas accesibles (v1: cada carpeta como destino raíz, sin subcarpetas).
  protected opcionesPersonal = computed<OpcionesExplorador>(() => ({
    etiquetaRaiz: 'Mis archivos',
    soportaBusqueda: true,
    soportaIA: true,
    aPapelera: true,
    destinoExterno:
      this.compartidas().length > 0
        ? {
            etiqueta: 'Compartido',
            dropAttr: 'data-drop-compartido',
            destinos: this.compartidas().map((c) => ({ id: c.id, etiqueta: c.nombre })),
          }
        : undefined,
  }));

  // Mover o copiar archivos/carpetas personales a una carpeta compartida. El
  // `destinoId` es el ccId destino. En 'mover' el original sale de Mis archivos; en
  // 'copiar' permanece. Las subcarpetas vacías se recrean en el compartido.
  exportarACompartido(pet: PeticionExportar, modo: 'mover' | 'copiar') {
    const ccId = pet.destinoId;
    if (!ccId) return; // sin carpeta compartida destino no hay nada que hacer
    const crearOps = [...pet.carpetasVacias]
      .sort((a, b) => a.length - b.length)
      .map((r) =>
        this.compartido.crearCarpeta(ccId, r).pipe(
          map(() => 'carpeta' as const),
          catchError(() => of('error' as const)),
        ),
      );
    const llamada = (id: string, carpeta: string) =>
      modo === 'mover'
        ? this.compartido.moverDesdePersonal(ccId, id, carpeta)
        : this.compartido.copiarDesdePersonal(ccId, id, carpeta);
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
            ? `No se pudo ${modo} a Compartido`
            : `${nuevos} ${verbo}(s) a Compartido, ${fallidos} fallaron`,
        );
      } else if (nuevos === 0 && dups > 0) {
        this.toast.exito(dups === 1 ? 'Ya estaba en Compartido' : `${dups} ya estaban en Compartido`);
      } else if (dups > 0) {
        this.toast.exito(`${nuevos} ${verbo}(s) a Compartido; ${dups} ya estaban`);
      } else {
        this.toast.exito(
          nuevos === 1 ? `${verbo[0].toUpperCase()}${verbo.slice(1)} a Compartido` : `${nuevos} ${verbos} a Compartido`,
        );
      }
      // Al mover, el original ya no está en Mis archivos: refrescar el explorador.
      if (modo === 'mover') this.explorador()?.recargar();
    });
  }
}
