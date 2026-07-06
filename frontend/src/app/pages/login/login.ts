import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { mensajeError } from '../../shared/errores';
import { PasswordInputComponent } from '../../shared/password-input.component';

@Component({
  selector: 'app-login',
  imports: [FormsModule, PasswordInputComponent],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private auth = inject(AuthService);
  private router = inject(Router);

  protected cargando = signal(false);
  protected error = signal<string | null>(null);
  protected email = '';
  protected password = '';

  enviar() {
    if (!this.email || !this.password) return;
    this.error.set(null);
    this.cargando.set(true);

    this.auth.login(this.email, this.password).subscribe({
      next: () => {
        // El superadmin no tiene archivos/chat: va directo a su panel.
        this.router.navigate([this.auth.esSuperadmin() ? '/plataforma' : '/inicio']);
      },
      error: (err) => {
        this.cargando.set(false);
        this.error.set(mensajeError(err));
      },
    });
  }
}
