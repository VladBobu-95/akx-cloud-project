import { Component, inject, signal } from '@angular/core';
import { ArchivosService } from '../../core/archivos.service';
import { ExploradorComponent } from './explorador';
import { CompartidoComponent } from './compartido';
import { OpcionesExplorador } from './fuente';

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

  // Personales (explorador de siempre) vs Compartido (carpetas por rol).
  protected ambito = signal<'personal' | 'compartido'>('personal');

  // Nº total de archivos personales (lo emite el explorador al cargar).
  protected total = signal(0);

  protected readonly opcionesPersonal: OpcionesExplorador = {
    etiquetaRaiz: 'Mis archivos',
    soportaBusqueda: true,
    soportaIA: true,
    aPapelera: true,
  };
}
