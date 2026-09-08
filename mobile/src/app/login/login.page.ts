import { ChangeDetectorRef, Component, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false,
})
export class LoginPage {
  email = '';
  password = '';
  mostrarPass = false;
  cargando = false;
  error: string | null = null;
  private tope: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private auth: AuthService,
    private router: Router,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  async ionViewWillEnter() {
    await this.auth.hidratar();
    if (this.auth.estaAutenticado()) {
      await this.router.navigateByUrl('/tabs/chat', { replaceUrl: true });
    }
  }

  enviar() {
    if (!this.email || !this.password || this.cargando) return;
    this.error = null;
    this.cargando = true;
    this.cdr.detectChanges();

    if (this.tope) clearTimeout(this.tope);
    this.tope = setTimeout(() => {
      this.zone.run(() => {
        if (this.cargando) {
          this.cargando = false;
          this.error = this.error || 'Sin respuesta del filtro. Revisa el deny o la red.';
          this.cdr.detectChanges();
        }
      });
    }, 35000);

    this.auth.login(this.email, this.password).subscribe({
      next: () => {
        this.zone.run(() => {
          if (this.tope) clearTimeout(this.tope);
          this.cargando = false;
          this.cdr.detectChanges();
          void this.router.navigateByUrl('/tabs/chat', { replaceUrl: true });
        });
      },
      error: (err) => {
        this.zone.run(() => {
          if (this.tope) clearTimeout(this.tope);
          this.cargando = false;
          this.error = this.auth.mensajeError(err);
          this.cdr.detectChanges();
        });
      },
    });
  }
}
