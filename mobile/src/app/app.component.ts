import { Component } from '@angular/core';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  constructor(private theme: ThemeService) {
    void this.theme.cuandoListo();
  }
}
