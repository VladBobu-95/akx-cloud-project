import { Component, Input, forwardRef, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

// Campo de contraseña con botón de "ver/ocultar" (el mismo ojo del login),
// reutilizable vía [(ngModel)] como cualquier input nativo (implementa
// ControlValueAccessor).
@Component({
  selector: 'app-password-input',
  standalone: true,
  template: `
    <div class="input-pass" [class.lg]="size === 'lg'">
      <input
        class="input"
        [type]="mostrar() ? 'text' : 'password'"
        [id]="id"
        [name]="name"
        [placeholder]="placeholder"
        [required]="required"
        [autocomplete]="autocomplete"
        [value]="value"
        (input)="onInput($event)"
        (blur)="onTouched()"
      />
      <button type="button" class="ojo" (click)="mostrar.set(!mostrar())" tabindex="-1">
        @if (mostrar()) {
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
        } @else {
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        }
      </button>
    </div>
  `,
  styles: [`
    .input-pass { position: relative; }
    .input-pass .input { padding-right: 42px; }
    .input-pass .input::-ms-reveal,
    .input-pass .input::-ms-clear { display: none; }
    /* Variante "lg" (login): campos más grandes, a juego con el resto del form. */
    .input-pass.lg .input {
      padding: 14px 42px 14px 16px;
      font-size: 1.05rem;
      caret-color: var(--green);
    }
    .ojo {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted);
      padding: 4px;
      display: flex;
      align-items: center;
    }
    .ojo:hover { color: var(--text); }
  `],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => PasswordInputComponent),
      multi: true,
    },
  ],
})
export class PasswordInputComponent implements ControlValueAccessor {
  @Input() id = '';
  @Input() name = '';
  @Input() placeholder = '';
  @Input() required = false;
  @Input() autocomplete = 'current-password';
  @Input() size: 'normal' | 'lg' = 'normal';

  protected mostrar = signal(false);
  protected value = '';
  private onChange: (v: string) => void = () => {};
  protected onTouched: () => void = () => {};

  onInput(ev: Event) {
    this.value = (ev.target as HTMLInputElement).value;
    this.onChange(this.value);
  }

  writeValue(v: string): void {
    this.value = v ?? '';
  }
  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
}
