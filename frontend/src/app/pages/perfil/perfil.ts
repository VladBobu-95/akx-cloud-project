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
  template: `
    <div class="head">
      <h1>Mi perfil</h1>
    </div>

    <!-- Avatar -->
    <div class="card seccion">
      <h2>Imagen de perfil</h2>
      <div class="avatar-row">
        <span class="avatar-grande">
          @if (auth.usuario()?.avatar) {
            <img [src]="auth.usuario()?.avatar" alt="avatar" />
          } @else {
            {{ inicial() }}
          }
        </span>
        <div class="avatar-acciones">
          <label class="file-pick">
            <input type="file" accept="image/*" (change)="seleccionarAvatar($event)" hidden />
            <span class="btn btn-outline">{{ subiendo() ? 'Guardando…' : 'Cambiar imagen' }}</span>
          </label>
          @if (auth.usuario()?.avatar) {
            <button class="btn btn-ghost" (click)="quitarAvatar()">Quitar</button>
          }
        </div>
      </div>
    </div>

    <!-- Apariencia -->
    <div class="card seccion">
      <h2>Apariencia</h2>
      <label class="switch-row">
        <span>Modo oscuro</span>
        <input type="checkbox" [checked]="theme.oscuro()" (change)="theme.alternar()" />
      </label>
    </div>

    <!-- Nombre -->
    <div class="card seccion">
      <h2>Nombre de usuario</h2>
      <div class="field">
        <input class="input" [(ngModel)]="nombre" placeholder="Tu nombre" />
      </div>
      <button class="btn btn-primary" (click)="guardarNombre()" [disabled]="!nombre.trim()">
        Guardar nombre
      </button>
    </div>

    <!-- Contraseña -->
    <div class="card seccion">
      <h2>Cambiar contraseña</h2>
      <div class="field">
        <input
          class="input"
          type="password"
          [(ngModel)]="password"
          placeholder="Nueva contraseña (mín. 8)"
          autocomplete="new-password"
        />
      </div>
      <button class="btn btn-primary" (click)="guardarPassword()" [disabled]="password.length < 8">
        Cambiar contraseña
      </button>
    </div>

    <!-- Info de cuenta -->
    <div class="card seccion">
      <h2>Información de la cuenta</h2>
      <p class="info"><span class="muted">Email:</span> {{ auth.usuario()?.email }}</p>
      <p class="info">
        <span class="muted">Miembro desde:</span>
        {{ auth.usuario()?.creadoEn ? (auth.usuario()?.creadoEn | date: 'dd/MM/yyyy') : '—' }}
      </p>
    </div>
  `,
  styles: [
    `
      .head {
        margin-bottom: 16px;
      }
      .seccion {
        margin-bottom: 16px;
        max-width: 520px;
      }
      .seccion h2 {
        margin-bottom: 14px;
      }
      .avatar-row {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .avatar-grande {
        width: 88px;
        height: 88px;
        border-radius: 50%;
        background: var(--green);
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 2rem;
        font-weight: 700;
        text-transform: uppercase;
        overflow: hidden;
        flex: none;
      }
      .avatar-grande img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .avatar-acciones {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .file-pick {
        cursor: pointer;
      }
      .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        font-weight: 600;
      }
      .switch-row input {
        width: 20px;
        height: 20px;
        cursor: pointer;
      }
      .info {
        margin-bottom: 6px;
      }
    `,
  ],
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
