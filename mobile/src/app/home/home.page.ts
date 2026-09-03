import { Component } from '@angular/core';
import { AuthService, Usuario } from '../core/auth.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage {
  usuario: Usuario | null = null;

  constructor(private auth: AuthService) {}

  ionViewWillEnter() {
    this.usuario = this.auth.usuario.value;
  }

  inicial(): string {
    const u = this.usuario;
    return (u?.nombre || u?.email || '?').charAt(0).toUpperCase();
  }

  salir() {
    void this.auth.logout();
  }
}
