import { Location } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/lazy';
import { AuthService, Usuario } from '../core/auth.service';
import { ThemeService } from '../core/theme.service';

@Component({
  selector: 'app-perfil',
  templateUrl: 'perfil.page.html',
  styleUrls: ['perfil.page.scss'],
  standalone: false,
})
export class PerfilPage {
  usuario: Usuario | null = null;
  nombre = '';
  password = '';
  mostrarPass = false;
  subiendo = false;
  guardandoNombre = false;
  guardandoPass = false;
  error: string | null = null;
  empresaNif: string | null = null;
  nifEdit = '';
  guardandoNif = false;
  confirmandoSalir = false;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  constructor(
    public auth: AuthService,
    public theme: ThemeService,
    private toasts: ToastController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
    private location: Location,
    private router: Router,
  ) {}

  volver() {
    if (window.history.length > 1) this.location.back();
    else void this.router.navigateByUrl('/tabs/chat');
  }

  async ionViewWillEnter() {
    this.error = null;
    try {
      this.usuario = (await this.auth.refrescarPerfil()) ?? this.auth.usuario.value;
    } catch {
      this.usuario = this.auth.usuario.value;
    }
    this.nombre = this.usuario?.nombre ?? '';
    if (this.auth.esAdmin()) {
      try {
        const e = await this.auth.obtenerEmpresa();
        this.empresaNif = e.nif;
        this.nifEdit = e.nif ?? '';
      } catch (e) {
        this.error = e instanceof Error ? e.message : 'No se pudo cargar el CIF.';
      }
    }
    this.zone.run(() => this.cdr.detectChanges());
  }

  get inicial(): string {
    const u = this.usuario;
    return (u?.nombre || u?.email || '?').charAt(0).toUpperCase();
  }

  etiquetaRol(rol?: string): string {
    if (rol === 'superadmin') return 'Superadmin';
    if (rol === 'admin') return 'Admin';
    return 'Miembro';
  }

  fechaAlta(iso?: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  elegirAvatar() {
    this.fileInput?.nativeElement.click();
  }

  seleccionarAvatar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    this.subiendo = true;
    this.error = null;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.subiendo = false;
          this.cdr.detectChanges();
          return;
        }
        const min = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
        void this.guardar({ avatar: canvas.toDataURL('image/jpeg', 0.85) }, 'Imagen actualizada');
      };
      img.onerror = () => {
        this.subiendo = false;
        this.error = 'No se pudo leer la imagen.';
        this.cdr.detectChanges();
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  quitarAvatar() {
    void this.guardar({ avatar: '' }, 'Imagen eliminada');
  }

  guardarNombre() {
    const nombre = this.nombre.trim();
    if (!nombre || this.guardandoNombre) return;
    this.guardandoNombre = true;
    void this.guardar({ nombre }, 'Nombre actualizado', () => {
      this.guardandoNombre = false;
    });
  }

  guardarPassword() {
    if (this.password.length < 8 || this.guardandoPass) return;
    this.guardandoPass = true;
    void this.guardar({ password: this.password }, 'Contraseña actualizada', () => {
      this.password = '';
      this.guardandoPass = false;
    });
  }

  async guardarNif() {
    const nif = this.nifEdit.trim();
    if (this.guardandoNif || nif === (this.empresaNif ?? '')) return;
    this.guardandoNif = true;
    this.error = null;
    try {
      const e = await this.auth.actualizarEmpresa({ nif });
      this.empresaNif = e.nif;
      this.nifEdit = e.nif ?? '';
      await this.toast('CIF de la empresa actualizado.');
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo guardar el CIF.';
    } finally {
      this.guardandoNif = false;
      this.cdr.detectChanges();
    }
  }

  async alternarTema() {
    await this.theme.alternar();
    this.cdr.detectChanges();
  }

  pedirSalir() {
    this.confirmandoSalir = true;
  }

  confirmarSalir() {
    this.confirmandoSalir = false;
    void this.auth.logout();
  }

  private async guardar(
    datos: { nombre?: string; avatar?: string; password?: string },
    mensajeOk: string,
    despues?: () => void,
  ) {
    this.error = null;
    try {
      this.usuario = await this.auth.actualizarPerfil(datos);
      this.nombre = this.usuario?.nombre ?? this.nombre;
      await this.toast(mensajeOk);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo guardar.';
    } finally {
      this.subiendo = false;
      this.guardandoNombre = false;
      this.guardandoPass = false;
      despues?.();
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  private async toast(message: string) {
    const t = await this.toasts.create({ message, duration: 2000, position: 'bottom' });
    await t.present();
  }
}
