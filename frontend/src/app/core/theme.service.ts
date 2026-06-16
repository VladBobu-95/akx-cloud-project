import { Injectable, signal } from '@angular/core';

const TEMA_KEY = 'akx_tema';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  // true = modo oscuro. Se inicializa desde localStorage.
  readonly oscuro = signal<boolean>(localStorage.getItem(TEMA_KEY) === 'dark');

  constructor() {
    this.aplicar();
  }

  alternar(): void {
    this.oscuro.set(!this.oscuro());
    localStorage.setItem(TEMA_KEY, this.oscuro() ? 'dark' : 'light');
    this.aplicar();
  }

  private aplicar(): void {
    document.body.classList.toggle('dark', this.oscuro());
  }
}
