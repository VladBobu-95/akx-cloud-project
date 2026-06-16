import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  texto: string;
  tipo: 'ok' | 'error';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private id = 0;

  exito(texto: string) {
    this.mostrar(texto, 'ok');
  }

  error(texto: string) {
    this.mostrar(texto, 'error');
  }

  private mostrar(texto: string, tipo: 'ok' | 'error') {
    const id = ++this.id;
    this.toasts.update((t) => [...t, { id, texto, tipo }]);
    setTimeout(() => {
      this.toasts.update((t) => t.filter((x) => x.id !== id));
    }, 3500);
  }
}
