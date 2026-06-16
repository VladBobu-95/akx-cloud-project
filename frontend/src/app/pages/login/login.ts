import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="brand">
          <span class="logo-mark">▲</span> AKX <span class="green">Cloud</span>
        </div>

        <div class="tabs">
          <button
            [class.active]="modo() === 'login'"
            (click)="modo.set('login'); error.set(null)"
            type="button"
          >
            Iniciar sesión
          </button>
          <button
            [class.active]="modo() === 'registro'"
            (click)="modo.set('registro'); error.set(null)"
            type="button"
          >
            Crear cuenta
          </button>
        </div>

        <form (ngSubmit)="enviar()">
          @if (modo() === 'registro') {
            <div class="field">
              <label for="nombre">Nombre de usuario</label>
              <input
                id="nombre"
                class="input"
                type="text"
                name="nombre"
                [(ngModel)]="nombre"
                placeholder="Tu nombre"
                required
                autocomplete="username"
              />
            </div>
          }
          <div class="field">
            <label for="email">Email</label>
            <input
              id="email"
              class="input"
              type="email"
              name="email"
              [(ngModel)]="email"
              placeholder="tucorreo@ejemplo.com"
              required
              autocomplete="email"
            />
          </div>
          <div class="field">
            <label for="password">Contraseña</label>
            <div class="input-pass">
              <input
                id="password"
                class="input"
                [type]="verPassword() ? 'text' : 'password'"
                name="password"
                [(ngModel)]="password"
                placeholder="Mínimo 8 caracteres"
                required
                autocomplete="current-password"
              />
              <button type="button" class="ojo" (click)="verPassword.set(!verPassword())" tabindex="-1">
                @if (verPassword()) {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                } @else {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                }
              </button>
            </div>
          </div>

          @if (error()) {
            <p class="error-msg">{{ error() }}</p>
          }

          <button
            class="btn btn-primary full"
            type="submit"
            [disabled]="cargando() || !email || !password || (modo() === 'registro' && !nombre)"
          >
            {{ cargando() ? 'Procesando…' : modo() === 'login' ? 'Entrar' : 'Crear cuenta' }}
          </button>
        </form>
      </div>
    </div>
  `,
  styles: [
    `
      .auth-wrap {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(1200px 500px at 50% -10%, var(--green-soft), transparent), var(--bg);
      }
      .auth-card {
        width: 100%;
        max-width: 500px;
        padding: 38px;
        font-size: 1.15rem;
      }
      .auth-card .input {
        padding: 14px 16px;
        font-size: 1.05rem;
      }
      .auth-card .btn {
        padding: 14px;
        font-size: 1.05rem;
      }
      .auth-card label {
        font-size: 0.95rem;
      }
      .brand {
        text-align: center;
        font-weight: 800;
        font-size: 2.9rem;
        letter-spacing: -0.02em;
        margin-bottom: 24px;
      }
      .brand .green,
      .logo-mark {
        color: var(--green);
      }
      .tabs {
        display: flex;
        background: var(--surface);
        border-radius: 999px;
        padding: 4px;
        margin-bottom: 22px;
      }
      .tabs button {
        flex: 1;
        border: none;
        background: transparent;
        font: inherit;
        font-weight: 600;
        color: var(--muted);
        padding: 12px;
        border-radius: 999px;
        cursor: pointer;
      }
      .tabs button.active {
        background: var(--bg);
        color: var(--green-dark);
        box-shadow: var(--shadow-sm);
      }
      .full {
        width: 100%;
        margin-top: 4px;
      }
      .error-msg {
        text-align: center;
        font-size: 0.95rem;
        color: #d33;
      }
      .input-pass {
        position: relative;
      }
      .input-pass .input {
        padding-right: 42px;
      }
      .ojo {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        cursor: pointer;
        color: var(--muted);
        padding: 4px;
        display: flex;
        align-items: center;
      }
      .ojo:hover {
        color: var(--text);
      }
    `,
  ],
})
export class Login {
  private auth = inject(AuthService);
  private router = inject(Router);

  protected modo = signal<'login' | 'registro'>('login');
  protected cargando = signal(false);
  protected error = signal<string | null>(null);
  protected verPassword = signal(false);
  protected email = '';
  protected password = '';
  protected nombre = '';

  enviar() {
    if (!this.email || !this.password) return;
    if (this.modo() === 'registro' && !this.nombre) return;
    this.error.set(null);
    this.cargando.set(true);

    const obs =
      this.modo() === 'login'
        ? this.auth.login(this.email, this.password)
        : this.auth.registrar(this.email, this.password, this.nombre);

    obs.subscribe({
      next: () => {
        this.router.navigate(['/inicio']);
      },
      error: (err) => {
        this.cargando.set(false);
        this.error.set(mensajeError(err));
      },
    });
  }
}
