import { ChangeDetectorRef, Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { ActionSheetController, AlertController } from '@ionic/angular/lazy';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { addIcons } from 'ionicons';
import { ellipsisVertical, trashOutline } from 'ionicons/icons';
import { marked } from 'marked';
import { AuthService, Usuario } from '../core/auth.service';
import { ChatService, Mensaje } from '../core/chat.service';

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

  elegir(valor: string, id?: string) {
    if (this.chat.pensando) return;
    void this.lanzar(valor, id);
  }

  private async lanzar(texto: string, idOpcion?: string) {
    this.cdr.detectChanges();
    this.scrollAbajo();
    await this.chat.enviarMensaje(texto, idOpcion);
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
