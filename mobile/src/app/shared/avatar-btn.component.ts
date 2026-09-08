import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-avatar-btn',
  templateUrl: './avatar-btn.component.html',
  styleUrls: ['./avatar-btn.component.scss'],
  standalone: false,
})
export class AvatarBtnComponent {
  constructor(
    public auth: AuthService,
    private router: Router,
  ) {}

  abrir() {
    void this.router.navigateByUrl('/tabs/perfil');
  }

  inicial(nombre?: string, email?: string): string {
    return (nombre || email || '?').charAt(0).toUpperCase();
  }

  etiqueta(nombre?: string, email?: string): string {
    const n = (nombre || '').trim();
    if (n) return n;
    const mail = (email || '').trim();
    const i = mail.indexOf('@');
    return i > 0 ? mail.slice(0, i) : mail || 'Perfil';
  }
}
