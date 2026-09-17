import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { ThemeService } from '../../core/theme.service';
import { EquipoService } from '../../core/equipo.service';
import { ClavesService, ClaveApi } from '../../core/claves.service';
import { mensajeError } from '../../shared/errores';
import { PasswordInputComponent } from '../../shared/password-input.component';

@Component({
  selector: 'app-perfil',
  imports: [FormsModule, DatePipe, PasswordInputComponent],
  templateUrl: './perfil.html',
  styleUrl: './perfil.scss',
})
export class PerfilPage {
  protected auth = inject(AuthService);
  protected theme = inject(ThemeService);
  private toast = inject(ToastService);
  private equipo = inject(EquipoService);
  private clavesSvc = inject(ClavesService);

  protected nombre = this.auth.usuario()?.nombre ?? '';
  protected password = '';
  protected subiendo = signal(false);

  // CIF de la empresa (ancla venta/compra de facturas). Solo admin: el endpoint
  // /api/equipo/empresa es soloAdmin; el superadmin no tiene empresa.
  protected esAdmin = this.auth.usuario()?.rol === 'admin';
  protected empresaNif = signal<string | null>(null);
  protected nifEdit = '';
  protected guardandoNif = signal(false);

  protected claves = signal<ClaveApi[]>([]);
  protected claveNueva = signal<string | null>(null);
  protected nombreClave = 'n8n';
  protected creandoClave = signal(false);
  protected confirmacion = signal<{ titulo: string; mensaje: string; onOk: () => void } | null>(null);

  constructor() {
    if (this.esAdmin) {
      this.equipo.obtenerEmpresa().subscribe({
        next: (e) => {
          this.empresaNif.set(e.nif);
        },
        error: (err) => this.toast.error(mensajeError(err)),
      });
    }
    this.cargarClaves();
  }

  private cargarClaves() {
    this.clavesSvc.listar().subscribe({
      next: (lista) => this.claves.set(lista),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  generarClave() {
    this.creandoClave.set(true);
    this.claveNueva.set(null);
    this.clavesSvc.crear(this.nombreClave.trim() || undefined).subscribe({
      next: (c) => {
        this.creandoClave.set(false);
        this.claveNueva.set(c.clave);
        this.cargarClaves();
        this.toast.exito('Copia la clave ahora: no se volverá a mostrar');
      },
      error: (err) => {
        this.creandoClave.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  copiarClave() {
    const v = this.claveNueva();
    if (!v) return;
    void navigator.clipboard.writeText(v).then(
      () => this.toast.exito('Clave copiada'),
      () => this.toast.error('No se pudo copiar'),
    );
  }

  pedirRevocar(c: ClaveApi) {
    this.confirmacion.set({
      titulo: 'Revocar clave',
      mensaje: `n8n dejará de funcionar con ${c.prefijo}…`,
      onOk: () => {
        this.clavesSvc.revocar(c.id).subscribe({
          next: () => {
            this.confirmacion.set(null);
            if (this.claveNueva()?.startsWith(c.prefijo)) this.claveNueva.set(null);
            this.cargarClaves();
            this.toast.exito('Clave revocada');
          },
          error: (err) => this.toast.error(mensajeError(err)),
        });
      },
    });
  }

  guardarNif() {
    this.guardandoNif.set(true);
    this.equipo.actualizarEmpresa({ nif: this.nifEdit.trim() }).subscribe({
      next: (e) => {
        this.guardandoNif.set(false);
        this.empresaNif.set(e.nif);
        this.nifEdit = e.nif ?? '';
        this.toast.exito('CIF de la empresa actualizado');
      },
      error: (err) => {
        this.guardandoNif.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  protected inicial(): string {
    const u = this.auth.usuario();
    return (u?.nombre || u?.email || '?').charAt(0);
  }

  seleccionarAvatar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.subiendo.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Recorte cuadrado centrado y redimensionado a 128px.
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.subiendo.set(false);
          return;
        }
        const min = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
        this.guardar({ avatar: canvas.toDataURL('image/jpeg', 0.85) }, 'Imagen actualizada');
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  quitarAvatar() {
    this.guardar({ avatar: '' }, 'Imagen eliminada');
  }

  guardarNombre() {
    const nombre = this.nombre.trim();
    if (!nombre) return;
    this.guardar({ nombre }, 'Nombre actualizado');
  }

  guardarPassword() {
    if (this.password.length < 8) return;
    this.guardar({ password: this.password }, 'Contraseña actualizada', () => (this.password = ''));
  }

  private guardar(
    datos: { nombre?: string; avatar?: string; password?: string },
    mensajeOk: string,
    despues?: () => void,
  ) {
    this.auth.actualizarPerfil(datos).subscribe({
      next: () => {
        this.subiendo.set(false);
        this.toast.exito(mensajeOk);
        despues?.();
      },
      error: (err) => {
        this.subiendo.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }
}
