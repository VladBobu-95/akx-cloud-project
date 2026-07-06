import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { FacturasService } from '../../core/facturas.service';
import { ToastService } from '../../core/toast.service';
import { FacturaDetalle, FilaFactura, TipoFactura } from '../../core/models';
import { mensajeError } from '../../shared/errores';

type Pestana = 'todas' | 'venta' | 'compra' | 'desconocido';

@Component({
  selector: 'app-facturas',
  imports: [FormsModule, RouterLink],
  templateUrl: './facturas.html',
  styleUrl: './facturas.scss',
})
export class FacturasPage {
  private svc = inject(FacturasService);
  private toast = inject(ToastService);

  protected readonly PESTANAS: { id: Pestana; etiqueta: string }[] = [
    { id: 'todas', etiqueta: 'Todas' },
    { id: 'venta', etiqueta: 'Ventas' },
    { id: 'compra', etiqueta: 'Compras' },
    { id: 'desconocido', etiqueta: 'Sin clasificar' },
  ];

  protected pestana = signal<Pestana>('todas');
  protected filas = signal<FilaFactura[]>([]);
  protected total = signal(0);
  protected paginas = signal(1);
  protected pagina = signal(1);
  protected cargando = signal(false);

  // Editor
  protected form = signal<FacturaDetalle | null>(null);
  protected guardando = signal(false);

  constructor() {
    this.cargar();
  }

  cambiarPestana(p: Pestana) {
    if (this.pestana() === p) return;
    this.pestana.set(p);
    this.pagina.set(1);
    this.cargar();
  }

  irPagina(p: number) {
    if (p < 1 || p > this.paginas() || p === this.pagina()) return;
    this.pagina.set(p);
    this.cargar();
  }

  cargar() {
    this.cargando.set(true);
    const tipo = this.pestana() === 'todas' ? undefined : (this.pestana() as TipoFactura);
    this.svc.listar({ tipo, pagina: this.pagina(), limite: 20 }).subscribe({
      next: (r) => {
        this.filas.set(r.filas);
        this.total.set(r.total);
        this.paginas.set(r.paginas);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Editor ---
  abrirEditar(fila: FilaFactura) {
    this.svc.obtener(fila.id).subscribe({
      next: (d) => this.form.set({ ...d, lineas: d.lineas.map((l) => ({ ...l })) }),
      error: (err) => this.toast.error(mensajeError(err)),
    });
  }

  cerrarEditor() {
    this.form.set(null);
  }

  addLinea() {
    const f = this.form();
    if (!f) return;
    this.form.set({ ...f, lineas: [...f.lineas, { descripcion: '', cantidad: 1, precioUnit: 0, total: 0 }] });
  }

  quitarLinea(i: number) {
    const f = this.form();
    if (!f) return;
    this.form.set({ ...f, lineas: f.lineas.filter((_, idx) => idx !== i) });
  }

  guardar() {
    const f = this.form();
    if (!f) return;
    this.guardando.set(true);
    const payload: Partial<FacturaDetalle> = {
      numero: f.numero,
      fecha: f.fecha,
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
    };
    this.svc.actualizar(f.id, payload).subscribe({
      next: () => {
        this.guardando.set(false);
        this.form.set(null);
        this.toast.exito('Factura actualizada');
        this.cargar();
      },
      error: (err) => {
        this.guardando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // --- Formato ---
  private fmtCache = new Map<string, Intl.NumberFormat>();
  dinero(n: number, moneda = 'EUR'): string {
    const cod = moneda || 'EUR';
    let fmt = this.fmtCache.get(cod);
    if (!fmt) {
      try {
        fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: cod });
      } catch {
        fmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      this.fmtCache.set(cod, fmt);
    }
    return fmt.format(Number(n) || 0);
  }

  fecha(iso: string | null): string {
    if (!iso) return '—';
    const [a, m, d] = iso.split('-');
    return d && m && a ? `${d}/${m}/${a}` : iso;
  }

  etiquetaTipo(t: TipoFactura): string {
    return t === 'venta' ? 'Venta' : t === 'compra' ? 'Compra' : 'Sin clasificar';
  }
}
