import { Component, NgZone } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { AlertController } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import { chatbubblesOutline, folderOutline, receiptOutline, trashOutline } from 'ionicons/icons';
import { filter } from 'rxjs/operators';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-tabs',
  templateUrl: 'tabs.page.html',
  styleUrls: ['tabs.page.scss'],
  standalone: false,
})
export class TabsPage {
  enPerfil = false;
  private ping: ReturnType<typeof setInterval> | null = null;
  private expulsando = false;
  private quitarCerrar?: () => void;

  constructor(
    private auth: AuthService,
    private alertCtrl: AlertController,
    private zone: NgZone,
    private router: Router,
  ) {
    addIcons({
      'chatbubbles-outline': chatbubblesOutline,
      'folder-outline': folderOutline,
      'receipt-outline': receiptOutline,
      'trash-outline': trashOutline,
    });
    this.enPerfil = this.router.url.includes('/perfil');
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((e) => {
      this.enPerfil = e.urlAfterRedirects.includes('/perfil');
    });
    this.quitarCerrar = this.auth.alCerrarSesion(() => {
      this.expulsando = true;
      this.pararPing();
    });
  }

  ionViewWillEnter() {
    this.expulsando = false;
    this.pararPing();
    void this.vigilarFiltro();
    this.ping = setInterval(() => void this.vigilarFiltro(), 5_000);
  }

  ionViewWillLeave() {
    this.pararPing();
  }

  ngOnDestroy() {
    this.quitarCerrar?.();
    this.pararPing();
  }

  private pararPing() {
    if (this.ping) {
      clearInterval(this.ping);
      this.ping = null;
    }
  }

  private async vigilarFiltro() {
    if (this.expulsando) return;
    const r = await this.auth.pingFiltro();
    if (r.ok || this.expulsando) return;
    this.expulsando = true;
    this.pararPing();
    const msg = this.auth.mensajeBloqueo(r.motivo, r.ip);
    await this.zone.run(async () => {
      const alert = await this.alertCtrl.create({
        header: 'Acceso bloqueado',
        message: msg,
        buttons: ['Aceptar'],
        backdropDismiss: false,
      });
      await alert.present();
      await alert.onDidDismiss();
      await this.auth.logout();
    });
  }
}
