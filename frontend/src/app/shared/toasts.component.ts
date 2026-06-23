import { Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toasts',
  templateUrl: './toasts.component.html',
})
export class ToastsComponent {
  protected toast = inject(ToastService);
}
