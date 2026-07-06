import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthResponse, Usuario } from './models';
import { ChatService } from './chat.service';

const TOKEN_KEY = 'akx_token';
const USER_KEY = 'akx_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private chat = inject(ChatService);
  private base = `${environment.apiUrl}/api/auth`;

  // Usuario actual reactivo (para mostrar el email en la navbar, etc.)
  readonly usuario = signal<Usuario | null>(this.cargarUsuario());

  constructor() {
    // Refresca el perfil al arrancar (si hay sesión) para traer capacidades
    // actualizadas: si el admin le ha quitado una capacidad (p. ej. "chat")
    // con la sesión ya abierta, se reflejará al recargar sin re-loguearse.
    if (this.estaAutenticado()) this.refrescarPerfil();
  }

  esAdmin(): boolean {
    return this.usuario()?.rol === 'admin';
  }

  esSuperadmin(): boolean {
    return this.usuario()?.rol === 'superadmin';
  }

  // Capacidades funcionales del usuario. admin/superadmin las tienen todas (el
  // backend ya las expande), así que estos helpers valen para todos los roles.
  tieneCapacidad(cap: string): boolean {
    return this.usuario()?.capacidades?.includes(cap) ?? false;
  }

  // ¿Puede usar el chatbot? Gobierna el enlace de navegación, la ruta /inicio y
  // (como frontera real) el endpoint POST /api/chat en el backend.
  puedeChat(): boolean {
    return this.tieneCapacidad('chat');
  }

  // Re-lee el perfil del backend y actualiza el usuario local (incl. capacidades).
  private refrescarPerfil(): void {
    this.http.get<{ usuario: Usuario }>(`${this.base}/perfil`).subscribe({
      next: (r) => this.guardarUsuario(r.usuario),
      error: () => {}, // token caducado/red: el guard/interceptor ya lo gestionan
    });
  }

  login(email: string, password: string) {
    return this.http
      .post<AuthResponse>(`${this.base}/login`, { email, password })
      .pipe(tap((r) => this.guardarSesion(r)));
  }

  // No hay auto-registro: las cuentas las crean el superadmin (admins de empresa)
  // o el admin (miembros del equipo).

  // Actualiza el perfil (nombre, avatar, contraseña) y refresca el usuario local.
  actualizarPerfil(datos: { nombre?: string; avatar?: string; password?: string }) {
    return this.http
      .patch<{ usuario: Usuario }>(`${this.base}/perfil`, datos)
      .pipe(tap((r) => this.guardarUsuario(r.usuario)));
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.chat.reset(); // que el chat no se filtre al siguiente usuario
    this.usuario.set(null);
    this.router.navigate(['/login']);
  }

  token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  estaAutenticado(): boolean {
    return !!this.token();
  }

  private guardarSesion(r: AuthResponse): void {
    // Arranca una sesión nueva en limpio: si el navegador traía chat de otro
    // usuario (o el mismo sin haber cerrado sesión), no debe heredarse.
    this.chat.reset();
    localStorage.setItem(TOKEN_KEY, r.token);
    this.guardarUsuario(r.usuario);
  }

  private guardarUsuario(u: Usuario): void {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    this.usuario.set(u);
  }

  private cargarUsuario(): Usuario | null {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
    } catch {
      return null;
    }
  }
}
