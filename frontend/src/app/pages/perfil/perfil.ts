import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { ThemeService } from '../../core/theme.service';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-perfil',
  imports: [FormsModule, DatePipe],
  templateUrl: './perfil.html',
  styleUrl: './perfil.scss',
})
export class PerfilPage {
  protected auth = inject(AuthService);
  protected theme = inject(ThemeService);
  private toast = inject(ToastService);

  protected nombre = this.auth.usuario()?.nombre ?? '';
  protected password = '';
  protected subiendo = signal(false);

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
