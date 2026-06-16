import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <header class="navbar">
      <div class="container nav-inner">
        <a class="logo" routerLink="/inicio">
          <span class="logo-mark">▲</span> AKX <span class="logo-light">Cloud</span>
        </a>

        <nav class="nav-links">
          <a routerLink="/inicio" routerLinkActive="active">Inicio</a>
          <a routerLink="/archivos" routerLinkActive="active">Mis archivos</a>
          <a routerLink="/papelera" routerLinkActive="active">Papelera</a>
        </nav>

        <span class="spacer"></span>

        <a class="perfil" routerLink="/perfil" title="Mi perfil">
          <span class="avatar">
            @if (auth.usuario()?.avatar) {
              <img [src]="auth.usuario()?.avatar" alt="avatar" />
            } @else {
              {{ inicial() }}
            }
          </span>
          <span class="user-nombre">{{ auth.usuario()?.nombre || auth.usuario()?.email }}</span>
        </a>
        <button class="btn btn-outline btn-sm" (click)="auth.logout()">Cerrar sesión</button>
      </div>
    </header>

    <main class="container page">
      <router-outlet />
    </main>
  `,
  styles: [
    `
      .navbar {
        background: var(--bg);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      .nav-inner {
        display: flex;
        align-items: center;
        gap: 22px;
        height: 64px;
      }
      .logo {
        font-weight: 800;
        font-size: 1.6rem;
        color: var(--text);
        letter-spacing: -0.02em;
      }
      .logo-mark {
        color: var(--green);
        margin-right: 2px;
      }
      .logo-light {
        color: var(--green);
        font-weight: 700;
      }
      .nav-links {
        display: flex;
        gap: 6px;
      }
      .nav-links a {
        color: var(--muted);
        font-weight: 600;
        padding: 8px 14px;
        border-radius: 999px;
        font-size: 0.92rem;
      }
      .nav-links a:hover {
        background: var(--surface);
        color: var(--text);
      }
      .nav-links a.active {
        background: var(--green-soft);
        color: var(--green-dark);
      }
      .perfil {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 0.88rem;
        font-weight: 600;
      }
      .perfil:hover {
        color: var(--text);
      }
      .avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--green);
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        text-transform: uppercase;
        overflow: hidden;
        flex: none;
      }
      .avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      @media (max-width: 640px) {
        .user-nombre {
          display: none;
        }
        .nav-inner {
          gap: 12px;
        }
      }
    `,
  ],
})
export class Shell {
  protected auth = inject(AuthService);

  protected inicial(): string {
    const u = this.auth.usuario();
    return (u?.nombre || u?.email || '?').charAt(0);
  }
}
