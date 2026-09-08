import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const TEMA_KEY = 'akx_tema';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  oscuro = false;
  private listo: Promise<void>;

  constructor() {
    this.listo = this.hidratar();
  }

  async cuandoListo(): Promise<void> {
    await this.listo;
  }

  async hidratar(): Promise<void> {
    const { value } = await Preferences.get({ key: TEMA_KEY });
    this.oscuro = value === 'dark';
    this.aplicar();
  }

  async alternar(): Promise<void> {
    this.oscuro = !this.oscuro;
    await Preferences.set({ key: TEMA_KEY, value: this.oscuro ? 'dark' : 'light' });
    this.aplicar();
  }

  private aplicar(): void {
    document.body.classList.toggle('dark', this.oscuro);
    document.documentElement.classList.toggle('dark', this.oscuro);
    document.documentElement.classList.toggle('ion-palette-dark', this.oscuro);
  }
}
