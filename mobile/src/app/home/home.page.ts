import { ChangeDetectorRef, Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { ActionSheetController, AlertController } from '@ionic/angular/lazy';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { addIcons } from 'ionicons';
import { ellipsisVertical, trashOutline } from 'ionicons/icons';
import { marked } from 'marked';
import { AuthService, Usuario } from '../core/auth.service';
import { ChatService, Mensaje, TablaChat } from '../core/chat.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage {
  usuario: Usuario | null = null;

  @ViewChild('lista') lista?: ElementRef<HTMLElement>;

  constructor(
    private auth: AuthService,
    public chat: ChatService,
    private sheets: ActionSheetController,
    private alerts: AlertController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    addIcons({
      'ellipsis-vertical': ellipsisVertical,
      'trash-outline': trashOutline,
    });
  }

  async ionViewWillEnter() {
    this.usuario = this.auth.usuario.value;
    await this.chat.hidratar();
    this.cdr.detectChanges();
    this.scrollAbajo();
  }

  get mensajes(): Mensaje[] {
    return this.chat.mensajes;
  }

  renderBot(texto: string): string {
    return marked.parse(texto, { breaks: true, async: false }) as string;
  }

  // En el móvil la tabla del asistente se pinta como una línea por fila (las
  // columnas visibles separadas por "·"), con un máximo de filas.
  filasVisibles(t: TablaChat): TablaChat['filas'] {
    return t.filas.slice(0, 20);
  }

  lineaFila(t: TablaChat, fila: TablaChat['filas'][number]): string {
    const iMoneda = t.columnas.indexOf('moneda');
    const moneda = iMoneda >= 0 && typeof fila[iMoneda] === 'string' ? (fila[iMoneda] as string) : null;
    return t.columnas
      .map((c, i) => ({ c, v: fila[i] }))
      .filter(({ c, v }) => !c.endsWith('_id') && c !== 'moneda' && v !== null && v !== '')
      .map(({ c, v }) => {
        if (typeof v === 'boolean') return `${c.replace(/_/g, ' ')}: ${v ? 'sí' : 'no'}`;
        if (typeof v === 'number' && moneda && /total|subtotal|iva|importe|base|precio/.test(c)) {
          return this.formatImporte(v, moneda);
        }
        if (typeof v === 'number') return new Intl.NumberFormat('es-ES').format(v);
        const f = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        return f ? `${f[3]}/${f[2]}/${f[1]}` : String(v);
      })
      .join(' · ');
  }

  formatImporte(total: number, moneda: string): string {
    try {
      return new Intl.NumberFormat('es-ES', { style: 'currency', currency: moneda || 'EUR' }).format(total);
    } catch {
      return `${total} ${moneda || ''}`.trim();
    }
  }

  mostrarTeclado() {
    if (Capacitor.getPlatform() === 'android') void Keyboard.show();
  }

  enviar() {
    const texto = this.chat.borrador.trim();
    if (!texto) return;
    this.chat.borrador = '';
    void this.lanzar(texto);
  }

  private async lanzar(texto: string) {
    this.cdr.detectChanges();
    this.scrollAbajo();
    await this.chat.enviarMensaje(texto);
    this.zone.run(() => {
      this.cdr.detectChanges();
      this.scrollAbajo();
    });
  }

  async abrirMenu() {
    const sheet = await this.sheets.create({
      buttons: [
        {
          text: 'Limpiar conversación',
          icon: 'trash-outline',
          role: 'destructive',
          handler: () => {
            void this.pedirLimpiar();
          },
        },
        { text: 'Cancelar', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  private async pedirLimpiar() {
    if (!this.mensajes.length) return;
    const alert = await this.alerts.create({
      header: 'Limpiar conversación',
      message: 'Se borrará el historial de este chat.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Limpiar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role !== 'confirm') return;
    await this.chat.reset();
    this.cdr.detectChanges();
  }

  private scrollAbajo() {
    setTimeout(() => {
      const el = this.lista?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 40);
  }
}
