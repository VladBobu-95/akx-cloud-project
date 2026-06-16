import { Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toasts',
  template: `
    <div class="toasts">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class.error]="t.tipo === 'error'">{{ t.texto }}</div>
      }
    </div>
  `,
})
export class ToastsComponent {
  protected toast = inject(ToastService);
}
