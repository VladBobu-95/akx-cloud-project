import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PlataformaService } from '../../core/plataforma.service';
import { ToastService } from '../../core/toast.service';
import { Empresa } from '../../core/models';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-plataforma',
  imports: [DatePipe, FormsModule],
  templateUrl: './plataforma.html',
  styleUrl: './plataforma.scss',
})
export class PlataformaPage {
  private svc = inject(PlataformaService);
  private toast = inject(ToastService);

  protected empresas = signal<Empresa[]>([]);
  protected cargando = signal(false);
  protected guardando = signal(false);

  // Modal "nueva empresa" (empresa + su primer admin).
  protected mostrarCrear = signal(false);
  protected nNombre = '';
  protected nNif = '';
  protected nAdminNombre = '';
  protected nAdminEmail = '';
  protected nAdminPassword = '';

  // Modal "renombrar empresa".
  protected editando = signal<Empresa | null>(null);
  protected eNombre = '';
  protected eNif = '';

  // Confirmación de borrado (acción destructiva).
  protected confirmacion = signal<{ empresa: Empresa } | null>(null);

  constructor() {
    this.cargar();
  }

  cargar() {
    this.cargando.set(true);
    this.svc.listarEmpresas().subscribe({
      next: (e) => {
        this.empresas.set(e);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Crear ---
  abrirCrear() {
    this.nNombre = '';
    this.nNif = '';
    this.nAdminNombre = '';
    this.nAdminEmail = '';
    this.nAdminPassword = '';
    this.mostrarCrear.set(true);
  }

  crear() {
    if (!this.nNombre || !this.nAdminEmail || !this.nAdminPassword || !this.nAdminNombre) return;
    this.guardando.set(true);
    this.svc
      .crearEmpresa({
        nombre: this.nNombre,
        nif: this.nNif.trim() || undefined,
        admin: {
          nombre: this.nAdminNombre,
          email: this.nAdminEmail,
          password: this.nAdminPassword,
        },
      })
      .subscribe({
        next: (r) => {
          this.guardando.set(false);
          this.mostrarCrear.set(false);
          this.toast.exito(`Empresa "${r.empresa.nombre}" creada`);
          this.cargar();
        },
        error: (err) => {
          this.guardando.set(false);
          this.toast.error(mensajeError(err));
        },
      });
  }

  // --- Editar (renombrar) ---
  abrirEditar(empresa: Empresa) {
    this.eNombre = empresa.nombre;
    this.eNif = empresa.nif ?? '';
    this.editando.set(empresa);
  }

  guardarEditar() {
    const empresa = this.editando();
    if (!empresa || !this.eNombre) return;
    this.guardando.set(true);
    this.svc.actualizarEmpresa(empresa.id, { nombre: this.eNombre, nif: this.eNif.trim() }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.editando.set(null);
        this.toast.exito('Empresa actualizada');
        this.cargar();
      },
      error: (err) => {
        this.guardando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Suspender / reactivar ---
  toggleEstado(empresa: Empresa) {
    const nuevo = empresa.estado === 'activa' ? 'suspendida' : 'activa';
    this.svc.actualizarEmpresa(empresa.id, { estado: nuevo }).subscribe({
      next: () => {
        this.toast.exito(nuevo === 'suspendida' ? 'Empresa suspendida' : 'Empresa reactivada');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  // --- Borrar ---
  pedirEliminar(empresa: Empresa) {
    this.confirmacion.set({ empresa });
  }

  ejecutarEliminar() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    if (!c) return;
    this.svc.eliminarEmpresa(c.empresa.id).subscribe({
      next: () => {
        this.toast.exito('Empresa eliminada');
        this.cargar();
      },
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }
}
