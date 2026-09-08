import { ChangeDetectorRef, Component, NgZone } from '@angular/core';
import { ToastController } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import { receiptOutline } from 'ionicons/icons';
import {
  FacturaDetalle,
  FacturasService,
  FilaFactura,
  LineaFactura,
  TipoFactura,
} from '../core/facturas.service';


type Pestana = 'todas' | TipoFactura;

@Component({
  selector: 'app-facturas',
  templateUrl: 'facturas.page.html',
  styleUrls: ['facturas.page.scss'],
  standalone: false,
})
export class FacturasPage {
  readonly pestanas: { id: Pestana; etiqueta: string }[] = [
    { id: 'todas', etiqueta: 'Todas' },
    { id: 'venta', etiqueta: 'Ventas' },
    { id: 'compra', etiqueta: 'Compras' },
    { id: 'desconocido', etiqueta: 'Sin clasificar' },
  ];

  pestana: Pestana = 'todas';
  filas: FilaFactura[] = [];
  total = 0;
  paginas = 1;
  pagina = 1;
  limite = 20;
  cargando = false;
  error: string | null = null;
  reclasificando = false;
  form: FacturaDetalle | null = null;
  guardando = false;

  constructor(
    private api: FacturasService,
    private toasts: ToastController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    addIcons({
      'receipt-outline': receiptOutline,
    });
  }

  ionViewWillEnter() {
    void this.cargar();
  }

  cambiarPestana(p: Pestana) {
    if (this.pestana === p) return;
    this.pestana = p;
    this.pagina = 1;
    void this.cargar();
  }

  async cargar() {
    this.cargando = true;
    this.error = null;
    try {
      const tipo = this.pestana === 'todas' ? undefined : this.pestana;
      const r = await this.api.listar({ tipo, pagina: this.pagina, limite: this.limite });
      this.filas = r.filas;
      this.total = r.total;
      this.paginas = r.paginas;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudieron cargar las facturas.';
      this.filas = [];
    } finally {
      this.cargando = false;
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  irPagina(p: number) {
    if (p < 1 || p > this.paginas || p === this.pagina) return;
    this.pagina = p;
    void this.cargar();
  }

  async reclasificar() {
    this.reclasificando = true;
    this.error = null;
    try {
      const r = await this.api.reclasificar();
      await this.toast(
        r.actualizadas > 0
          ? `${r.actualizadas} factura(s) reclasificada(s)`
          : 'Sin cambios. Revisa el CIF de la empresa en Equipo (web).',
      );
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo reclasificar.';
    } finally {
      this.reclasificando = false;
      this.cdr.detectChanges();
    }
  }

  async abrir(fila: FilaFactura) {
    this.error = null;
    try {
      const d = await this.api.obtener(fila.id);
      this.form = {
        ...d,
        fecha: this.fechaInput(d.fecha),
        lineas: (d.lineas ?? []).map((l) => ({ ...l })),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo abrir la factura.';
    }
    this.cdr.detectChanges();
  }

  cerrarEditor() {
    this.form = null;
  }

  addLinea() {
    if (!this.form) return;
    this.form.lineas = [...this.form.lineas, { descripcion: '', cantidad: 1, precioUnit: 0, total: 0 }];
  }

  quitarLinea(i: number) {
    if (!this.form) return;
    this.form.lineas = this.form.lineas.filter((_, idx) => idx !== i);
  }

  async guardar() {
    const f = this.form;
    if (!f || this.guardando) return;
    this.guardando = true;
    this.error = null;
    try {
      await this.api.actualizar(f.id, {
        numero: f.numero,
        fecha: f.fecha || null,
        emisor: f.emisor,
        emisorNif: f.emisorNif,
        cliente: f.cliente,
        clienteNif: f.clienteNif,
        tipo: f.tipo,
        moneda: f.moneda,
        subtotal: Number(f.subtotal) || 0,
        iva: Number(f.iva) || 0,
        total: Number(f.total) || 0,
        lineas: f.lineas.map((l) => ({
          descripcion: l.descripcion,
          cantidad: Number(l.cantidad) || 0,
          precioUnit: Number(l.precioUnit) || 0,
          total: Number(l.total) || 0,
        })),
      });
      this.form = null;
      await this.toast('Factura actualizada.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo guardar.';
    } finally {
      this.guardando = false;
      this.cdr.detectChanges();
    }
  }

  dinero(n: number, moneda = 'EUR'): string {
    const cod = moneda || 'EUR';
    try {
      return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cod }).format(Number(n) || 0);
    } catch {
      return `${(Number(n) || 0).toFixed(2)} ${cod}`;
    }
  }

  fechaCorta(iso: string | null): string {
    if (!iso) return '—';
    const d = iso.slice(0, 10);
    const [a, m, dia] = d.split('-');
    return dia && m && a ? `${dia}/${m}/${a.slice(2)}` : iso;
  }

  fechaInput(iso: string | null): string {
    if (!iso) return '';
    return iso.slice(0, 10);
  }

  etiquetaTipo(t: TipoFactura): string {
    return t === 'venta' ? 'Venta' : t === 'compra' ? 'Compra' : 'Sin clasificar';
  }

  tituloFila(f: FilaFactura): string {
    return f.numero || f.archivoNombre || 'Factura';
  }

  trackFila(_i: number, f: FilaFactura) {
    return f.id;
  }

  trackLinea(i: number, _l: LineaFactura) {
    return i;
  }

  private async toast(message: string) {
    const t = await this.toasts.create({ message, duration: 2200, position: 'bottom' });
    await t.present();
  }
}
