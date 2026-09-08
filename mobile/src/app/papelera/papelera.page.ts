import { ChangeDetectorRef, Component, NgZone } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import { arrowUndoOutline, close, trashOutline } from 'ionicons/icons';
import {
  Archivo,
  ArchivosService,
  hijasDe,
  nombreHoja,
  normalizarRuta,
  padreDe,
  tamanoHumano,
} from '../core/archivos.service';


type Sel = { archivos: Set<string>; carpetas: Set<string> };

@Component({
  selector: 'app-papelera',
  templateUrl: 'papelera.page.html',
  styleUrls: ['papelera.page.scss'],
  standalone: false,
})
export class PapeleraPage {
  ruta = '';
  todos: Archivo[] = [];
  todasRutas: string[] = [];
  carpetas: string[] = [];
  archivos: Archivo[] = [];
  cargando = false;
  error: string | null = null;
  sel: Sel = { archivos: new Set(), carpetas: new Set() };
  tamanoHumano = tamanoHumano;

  constructor(
    private api: ArchivosService,
    private alerts: AlertController,
    private toasts: ToastController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    addIcons({
      close,
      'arrow-undo-outline': arrowUndoOutline,
      'trash-outline': trashOutline,
    });
  }

  ionViewWillEnter() {
    void this.cargar();
  }

  get titulo(): string {
    return this.ruta ? nombreHoja(this.ruta) : 'Papelera';
  }

  get puedeVolver(): boolean {
    return this.ruta.length > 0;
  }

  get numSel(): number {
    return this.sel.archivos.size + this.sel.carpetas.size;
  }

  get haySel(): boolean {
    return this.numSel > 0;
  }

  get etiquetaSel(): string {
    return this.numSel === 1 ? '1 seleccionado' : `${this.numSel} seleccionados`;
  }

  get todosMarcados(): boolean {
    const n = this.carpetas.length + this.archivos.length;
    return n > 0 && this.numSel === n;
  }

  tituloHoja(ruta: string): string {
    return nombreHoja(ruta);
  }

  async cargar() {
    this.cargando = true;
    this.error = null;
    try {
      this.todos = await this.api.listarPapelera();
      const rutas = new Set<string>();
      for (const a of this.todos) {
        let r = normalizarRuta(a.carpeta);
        while (r) {
          rutas.add(r);
          r = padreDe(r);
        }
      }
      this.todasRutas = [...rutas].sort();
      if (this.ruta && !rutas.has(this.ruta)) this.ruta = '';
      this.aplicarRuta();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo cargar la papelera.';
      this.todos = [];
      this.archivos = [];
      this.carpetas = [];
    } finally {
      this.cargando = false;
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  private aplicarRuta() {
    const actual = normalizarRuta(this.ruta);
    this.archivos = this.todos
      .filter((a) => normalizarRuta(a.carpeta) === actual)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    this.carpetas = hijasDe(this.todasRutas, actual);
  }

  entrar(carpeta: string) {
    this.limpiarSel();
    this.ruta = carpeta;
    this.aplicarRuta();
  }

  volver() {
    this.limpiarSel();
    this.ruta = padreDe(this.ruta);
    this.aplicarRuta();
  }

  clickCarpeta(c: string) {
    if (this.haySel) {
      this.toggleC(c);
      return;
    }
    this.entrar(c);
  }

  clickArchivo(id: string) {
    this.toggleA(id);
  }

  marcadoA(id: string) {
    return this.sel.archivos.has(id);
  }
  marcadoC(ruta: string) {
    return this.sel.carpetas.has(ruta);
  }

  toggleA(id: string, ev?: Event) {
    ev?.stopPropagation();
    const archivos = new Set(this.sel.archivos);
    if (archivos.has(id)) archivos.delete(id);
    else archivos.add(id);
    this.sel = { archivos, carpetas: new Set(this.sel.carpetas) };
  }

  toggleC(ruta: string, ev?: Event) {
    ev?.stopPropagation();
    const carpetas = new Set(this.sel.carpetas);
    if (carpetas.has(ruta)) carpetas.delete(ruta);
    else carpetas.add(ruta);
    this.sel = { archivos: new Set(this.sel.archivos), carpetas };
  }

  toggleTodo() {
    if (this.todosMarcados) this.limpiarSel();
    else {
      this.sel = {
        archivos: new Set(this.archivos.map((a) => a.id)),
        carpetas: new Set(this.carpetas),
      };
    }
  }

  limpiarSel() {
    this.sel = { archivos: new Set(), carpetas: new Set() };
  }

  private archivosDeSel(): Archivo[] {
    const ids = new Set(this.sel.archivos);
    for (const c of this.sel.carpetas) {
      const pref = normalizarRuta(c);
      for (const a of this.todos) {
        const k = normalizarRuta(a.carpeta);
        if (k === pref || k.startsWith(pref + '/')) ids.add(a.id);
      }
    }
    return this.todos.filter((a) => ids.has(a.id));
  }

  archivosBajo(ruta: string): Archivo[] {
    const pref = normalizarRuta(ruta);
    return this.todos.filter((a) => {
      const k = normalizarRuta(a.carpeta);
      return k === pref || k.startsWith(pref + '/');
    });
  }

  tamanoCarpeta(ruta: string): string {
    const bytes = this.archivosBajo(ruta).reduce((acc, a) => acc + (Number(a.tamanoBytes) || 0), 0);
    return bytes ? tamanoHumano(bytes) : '0 KB';
  }

  fechaCarpeta(ruta: string): string {
    let max = '';
    for (const a of this.archivosBajo(ruta)) {
      if (a.eliminadoEn && a.eliminadoEn > max) max = a.eliminadoEn;
    }
    return this.fechaCorta(max || null);
  }

  fechaCorta(iso?: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  tamanoDe(a: Archivo): string {
    return tamanoHumano(a.tamanoBytes);
  }

  async restaurarSel() {
    const afectados = this.archivosDeSel();
    if (!afectados.length) return;
    try {
      for (const a of afectados) await this.api.restaurar(a.id);
      this.limpiarSel();
      await this.toast(
        afectados.length === 1 ? 'Restaurado.' : `${afectados.length} elementos restaurados.`,
      );
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo restaurar.';
      this.cdr.detectChanges();
    }
  }

  async borrarSel() {
    const afectados = this.archivosDeSel();
    if (!afectados.length) return;
    const ok = await this.confirmar(
      'Borrar definitivamente',
      afectados.length === 1
        ? `Borrar "${afectados[0].nombre}" de forma permanente. No se puede deshacer.`
        : `Borrar ${afectados.length} elementos de forma permanente. No se puede deshacer.`,
    );
    if (!ok) return;
    try {
      for (const a of afectados) await this.api.borrarPermanente(a.id);
      this.limpiarSel();
      await this.toast('Eliminado de forma permanente.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo borrar.';
      this.cdr.detectChanges();
    }
  }

  async vaciar() {
    if (!this.todos.length) return;
    const ok = await this.confirmar(
      'Vaciar papelera',
      `Se borrarán ${this.todos.length} archivo(s) de forma permanente. No se puede deshacer.`,
    );
    if (!ok) return;
    try {
      const r = await this.api.vaciarPapelera();
      this.limpiarSel();
      this.ruta = '';
      await this.toast(`Papelera vaciada (${r.borrados}).`);
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo vaciar.';
      this.cdr.detectChanges();
    }
  }

  private async confirmar(header: string, message: string): Promise<boolean> {
    const alert = await this.alerts.create({
      header,
      message,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Confirmar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    return role === 'confirm';
  }

  private async toast(message: string) {
    const t = await this.toasts.create({ message, duration: 2000, position: 'bottom' });
    await t.present();
  }
}
