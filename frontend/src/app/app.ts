import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastsComponent } from './shared/toasts.component';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastsComponent],
  template: `
    <router-outlet />
    <app-toasts />
  `,
})
export class App {
  // Instanciar el servicio de tema aplica el modo (claro/oscuro) guardado al arrancar.
  private theme = inject(ThemeService);
}
