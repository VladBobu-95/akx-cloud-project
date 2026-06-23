import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
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
