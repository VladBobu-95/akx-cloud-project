import { ChangeDetectorRef, Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { ActionSheetController, AlertController, ToastController } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import {
  close,
  copyOutline,
  createOutline,
  downloadOutline,
  ellipsisHorizontal,
  folderOutline,
  moveOutline,
  openOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  Archivo,
  ArchivosService,
  EspacioCompartido,
  ResultadoBusqueda,
  Visor,
  hijasDe,
  nombreHoja,
  normalizarRuta,
  padreDe,
  tamanoHumano,
  unirRuta,
} from '../core/archivos.service';


type Sel = { archivos: Set<string>; carpetas: Set<string> };
type DragItem = { tipo: 'archivo' | 'carpeta'; id: string; nombre: string };
type Drag = { items: DragItem[]; nombre: string; x: number; y: number };

@Component({
  selector: 'app-archivos',
  templateUrl: 'archivos.page.html',
  styleUrls: ['archivos.page.scss'],
  standalone: false,
})
export class ArchivosPage {
  ambito: 'personal' | 'compartido' = 'personal';
  ccId: string | null = null;
  ccNombre = '';
  espacios: EspacioCompartido[] = [];
  ruta = '';
  todasRutas: string[] = [];
  todos: Archivo[] = [];
  carpetas: string[] = [];
  archivos: Archivo[] = [];
  cargando = false;
  error: string | null = null;
  subiendo = false;
  abriendo = false;
  consulta = '';
  buscando = false;
  resultados: ResultadoBusqueda[] | null = null;
  visor: Visor | null = null;
  sel: Sel = { archivos: new Set(), carpetas: new Set() };
  drag: Drag | null = null;
  destinoHover: string | '..' | null = null;
  tamanoHumano = tamanoHumano;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  private poll: ReturnType<typeof setInterval> | null = null;
  private dragStart: { x: number; y: number; tipo: 'archivo' | 'carpeta'; id: string; nombre: string } | null = null;
  private arrastreHecho = false;
  private onMove = (ev: PointerEvent) => this.enPointerMove(ev);
  private onUp = () => void this.enPointerUp();

  constructor(
    public archivosApi: ArchivosService,
    private alerts: AlertController,
    private sheets: ActionSheetController,
    private toasts: ToastController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    addIcons({
      close,
      'folder-outline': folderOutline,
      'copy-outline': copyOutline,
      'create-outline': createOutline,
      'download-outline': downloadOutline,
      'ellipsis-horizontal': ellipsisHorizontal,
      'move-outline': moveOutline,
      'open-outline': openOutline,
      'trash-outline': trashOutline,
    });
  }

  ionViewWillEnter() {
    document.addEventListener('pointermove', this.onMove, { passive: false });
    document.addEventListener('pointerup', this.onUp);
    document.addEventListener('pointercancel', this.onUp);
    void this.cargar();
    this.poll = setInterval(() => {
      if (this.archivos.some((a) => this.archivosApi.procesando(a))) void this.cargar(true);
    }, 3000);
  }

  ionViewWillLeave() {
    document.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('pointercancel', this.onUp);
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.cerrarVisor();
  }

  get enRaizCompartido(): boolean {
    return this.ambito === 'compartido' && !this.ccId;
  }

  get tituloCabecera(): string {
    return this.ambito === 'compartido' ? 'Compartido' : 'Mis archivos';
  }

  get titulo(): string {
    if (this.enRaizCompartido) return 'Compartido';
    if (this.ruta) return nombreHoja(this.ruta);
    return this.ccNombre || 'Mis archivos';
  }

  get puedeVolver(): boolean {
    return this.ruta.length > 0 || !!this.ccId;
  }

  get numSel(): number {
    return this.sel.archivos.size + this.sel.carpetas.size;
  }

  get haySel(): boolean {
    return this.numSel > 0;
  }

  get todosMarcados(): boolean {
    const n = this.carpetas.length + this.archivos.length;
    return n > 0 && this.numSel === n;
  }

  get unArchivo(): Archivo | null {
    if (this.sel.archivos.size !== 1 || this.sel.carpetas.size !== 0) return null;
    const id = [...this.sel.archivos][0];
    return this.todos.find((a) => a.id === id) ?? this.archivos.find((a) => a.id === id) ?? null;
  }

  get unaCarpeta(): string | null {
    if (this.sel.carpetas.size !== 1 || this.sel.archivos.size !== 0) return null;
    return [...this.sel.carpetas][0];
  }

  get etiquetaSel(): string {
    return this.numSel === 1 ? '1 seleccionado' : `${this.numSel} seleccionados`;
  }

  get puedeAbrir(): boolean {
    return !!(this.unArchivo || this.unaCarpeta);
  }

  get hayMas(): boolean {
    return !!(this.unArchivo || this.unaCarpeta);
  }

  tituloHoja(ruta: string): string {
    return nombreHoja(ruta);
  }

  esImagen(v: Visor): boolean {
    return v.mime.startsWith('image/') && !!v.url;
  }

  setAmbito(v: 'personal' | 'compartido') {
    if (this.ambito === v) return;
    this.ambito = v;
    this.ccId = null;
    this.ccNombre = '';
    this.ruta = '';
    this.resultados = null;
    this.consulta = '';
    this.limpiarSel();
    void this.cargar();
  }

  volver() {
    if (this.drag) return;
    this.limpiarSel();
    this.resultados = null;
    if (this.ruta) {
      this.ruta = padreDe(this.ruta);
    } else if (this.ccId) {
      this.ccId = null;
      this.ccNombre = '';
    }
    void this.cargar();
  }

  clickCarpeta(carpeta: string) {
    if (this.arrastreHecho || this.drag) return;
    this.entrar(carpeta);
  }

  clickArchivo(a: Archivo) {
    if (this.arrastreHecho || this.drag) return;
    void this.abrir(a);
  }

  entrar(carpeta: string) {
    this.limpiarSel();
    this.ruta = carpeta;
    void this.cargar();
  }

  entrarSel() {
    if (this.unaCarpeta) this.entrar(this.unaCarpeta);
  }

  abrirEspacio(e: EspacioCompartido) {
    this.ccId = e.id;
    this.ccNombre = e.nombre;
    this.ruta = '';
    this.limpiarSel();
    void this.cargar();
  }

  async cargar(silencioso = false) {
    if (!silencioso) {
      this.cargando = true;
      this.error = null;
    }
    try {
      if (this.enRaizCompartido) {
        this.espacios = await this.archivosApi.espaciosCompartidos();
        this.archivos = [];
        this.carpetas = [];
        this.todos = [];
        this.todasRutas = [];
      } else {
        const actual = normalizarRuta(this.ruta);
        const [todos, metas] = await Promise.all([
          this.archivosApi.listarTodos(this.ccId),
          this.archivosApi.listarCarpetas(this.ccId),
        ]);
        this.todos = todos;
        this.archivos = todos
          .filter((a) => normalizarRuta(a.carpeta) === actual)
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        const rutas = new Set(metas.map((c) => normalizarRuta(c.ruta)).filter(Boolean));
        for (const a of todos) {
          let r = normalizarRuta(a.carpeta);
          while (r) {
            rutas.add(r);
            r = padreDe(r);
          }
        }
        this.todasRutas = [...rutas].sort();
        this.carpetas = hijasDe(this.todasRutas, actual);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudieron cargar los archivos.';
    } finally {
      this.cargando = false;
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  elegirArchivo() {
    this.fileInput?.nativeElement.click();
  }

  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || this.enRaizCompartido) return;
    this.subiendo = true;
    this.error = null;
    try {
      await this.archivosApi.subir(file, this.ruta, this.ccId);
      await this.toast('Archivo subido.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo subir.';
    } finally {
      this.subiendo = false;
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  async nuevaCarpeta() {
    if (this.enRaizCompartido) return;
    const nombre = await this.pedirTexto('Nueva carpeta', 'Nombre');
    if (!nombre) return;
    try {
      await this.archivosApi.crearCarpeta(this.ccId, unirRuta(this.ruta, nombre));
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear la carpeta.';
      this.cdr.detectChanges();
    }
  }

  async buscar() {
    const q = this.consulta.trim();
    if (!q || this.enRaizCompartido) return;
    this.buscando = true;
    this.error = null;
    try {
      this.resultados = await this.archivosApi.buscar(q, this.ccId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo buscar.';
      this.resultados = [];
    } finally {
      this.buscando = false;
      this.cdr.detectChanges();
    }
  }

  limpiarBusqueda() {
    this.consulta = '';
    this.resultados = null;
  }

  async abrirResultado(r: ResultadoBusqueda) {
    const a = this.todos.find((x) => x.id === r.archivoId);
    if (a) {
      await this.abrir(a);
      return;
    }
    this.ruta = normalizarRuta(r.carpeta);
    this.resultados = null;
    await this.cargar();
  }

  async abrir(a: Archivo) {
    if (this.drag || this.abriendo) return;
    this.abriendo = true;
    this.error = null;
    this.cdr.detectChanges();
    try {
      const visor = await this.archivosApi.abrir(a, this.ccId);
      if (visor) this.visor = visor;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo abrir.';
    } finally {
      this.abriendo = false;
      this.cdr.detectChanges();
    }
  }

  async abrirSel() {
    if (this.unArchivo) await this.abrir(this.unArchivo);
  }

  async abrirDesdeBarra() {
    if (this.unArchivo) {
      await this.abrir(this.unArchivo);
      return;
    }
    if (this.unaCarpeta) this.entrar(this.unaCarpeta);
  }

  async masAcciones() {
    const buttons: { text: string; icon?: string; role?: string; handler?: () => void }[] = [];
    if (this.unArchivo) {
      buttons.push({
        text: 'Descargar',
        icon: 'download-outline',
        handler: () => {
          void this.descargarSel();
        },
      });
    }
    if (this.unArchivo || this.unaCarpeta) {
      buttons.push({
        text: 'Renombrar',
        icon: 'create-outline',
        handler: () => {
          void this.renombrarSel();
        },
      });
    }
    buttons.push({ text: 'Cancelar', role: 'cancel' });
    const sheet = await this.sheets.create({ header: this.etiquetaSel, buttons });
    await sheet.present();
  }

  async descargarSel() {
    if (!this.unArchivo) return;
    try {
      await this.archivosApi.descargar(this.unArchivo, this.ccId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo descargar.';
      this.cdr.detectChanges();
    }
  }

  async renombrarSel() {
    const a = this.unArchivo;
    if (a) {
      const nombre = await this.pedirTexto('Renombrar', a.nombre, a.nombre);
      if (!nombre || nombre === a.nombre) return;
      try {
        await this.archivosApi.actualizar(a.id, { nombre }, this.ccId);
        this.limpiarSel();
        await this.cargar();
      } catch (e) {
        this.error = e instanceof Error ? e.message : 'No se pudo renombrar.';
        this.cdr.detectChanges();
      }
      return;
    }
    const c = this.unaCarpeta;
    if (!c) return;
    const nombre = await this.pedirTexto('Renombrar carpeta', nombreHoja(c), nombreHoja(c));
    if (!nombre || nombre === nombreHoja(c)) return;
    try {
      await this.archivosApi.reubicarCarpeta(this.ccId, c, unirRuta(padreDe(c), nombre));
      this.limpiarSel();
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo renombrar.';
      this.cdr.detectChanges();
    }
  }

  cerrarVisor() {
    if (this.visor?.url.startsWith('blob:')) URL.revokeObjectURL(this.visor.url);
    this.visor = null;
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

  destinos(): { ruta: string; etiqueta: string }[] {
    const prohibidas = new Set<string>();
    for (const c of this.sel.carpetas) {
      prohibidas.add(c);
      for (const r of this.todasRutas) if (r === c || r.startsWith(c + '/')) prohibidas.add(r);
    }
    const raiz = this.ccNombre || 'Mis archivos';
    const out: { ruta: string; etiqueta: string }[] = [{ ruta: '', etiqueta: raiz }];
    for (const r of this.todasRutas) {
      if (!prohibidas.has(r)) out.push({ ruta: r, etiqueta: r });
    }
    return out;
  }

  async pedirDestino(titulo: string): Promise<string | null> {
    const dest = this.destinos();
    const alert = await this.alerts.create({
      header: titulo,
      inputs: dest.map((d, i) => ({
        type: 'radio' as const,
        label: d.etiqueta || '/',
        value: d.ruta,
        checked: i === 0,
      })),
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Elegir', role: 'confirm' },
      ],
    });
    await alert.present();
    const { data, role } = await alert.onDidDismiss();
    if (role !== 'confirm') return null;
    const raw = data && typeof data === 'object' && 'values' in data ? (data as { values: unknown }).values : data;
    if (raw === undefined || raw === null) return null;
    return String(raw);
  }

  async bulkMover() {
    const dest = await this.pedirDestino('Mover a…');
    if (dest === null) return;
    await this.moverSel(dest);
  }

  async bulkCopiar() {
    const dest = await this.pedirDestino('Copiar en…');
    if (dest === null) return;
    await this.copiarSel(dest);
  }

  async bulkBorrar() {
    const n = this.numSel;
    const ok = await this.confirmar(
      'Borrar',
      this.ccId
        ? `Se eliminarán ${n} elemento(s) de forma definitiva.`
        : `Se enviarán ${n} elemento(s) a la papelera.`,
    );
    if (!ok) return;
    try {
      for (const id of this.sel.archivos) await this.archivosApi.eliminar(id, this.ccId);
      for (const c of this.sel.carpetas) await this.archivosApi.eliminarCarpeta(this.ccId, c);
      this.limpiarSel();
      await this.toast('Eliminado.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo borrar.';
      this.cdr.detectChanges();
    }
  }

  private async moverSel(dest: string) {
    try {
      for (const id of this.sel.archivos) await this.archivosApi.actualizar(id, { carpeta: dest }, this.ccId);
      for (const c of this.sel.carpetas) {
        await this.archivosApi.reubicarCarpeta(this.ccId, c, unirRuta(dest, nombreHoja(c)));
      }
      this.limpiarSel();
      await this.toast('Movido.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo mover.';
      this.cdr.detectChanges();
    }
  }

  private async copiarSel(dest: string) {
    try {
      for (const id of this.sel.archivos) await this.archivosApi.copiar(id, { carpeta: dest }, this.ccId);
      for (const c of this.sel.carpetas) {
        const destino = unirRuta(dest, nombreHoja(c));
        try {
          await this.archivosApi.crearCarpeta(this.ccId, destino);
        } catch {
          /* ya existía */
        }
        const pref = c;
        for (const a of this.todos.filter((x) => {
          const k = normalizarRuta(x.carpeta);
          return k === pref || k.startsWith(pref + '/');
        })) {
          const rel = normalizarRuta(a.carpeta).slice(pref.length).replace(/^\//, '');
          const carpetaDest = rel ? unirRuta(destino, rel) : destino;
          if (carpetaDest) {
            try {
              await this.archivosApi.crearCarpeta(this.ccId, carpetaDest);
            } catch {
              /* ya existía */
            }
          }
          await this.archivosApi.copiar(a.id, { carpeta: carpetaDest }, this.ccId);
        }
      }
      this.limpiarSel();
      await this.toast('Copiado.');
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo copiar.';
      this.cdr.detectChanges();
    }
  }

  iniciarPosibleArrastre(ev: PointerEvent, tipo: 'archivo' | 'carpeta', id: string, nombre: string) {
    if ((ev.target as HTMLElement).closest('.col-check')) return;
    this.arrastreHecho = false;
    this.dragStart = { x: ev.clientX, y: ev.clientY, tipo, id, nombre };
  }

  private itemsDeArrastre(tipo: 'archivo' | 'carpeta', id: string, nombre: string): DragItem[] {
    const seleccionado = tipo === 'archivo' ? this.sel.archivos.has(id) : this.sel.carpetas.has(id);
    if (!seleccionado || this.numSel <= 1) return [{ tipo, id, nombre }];
    const items: DragItem[] = [];
    for (const c of this.sel.carpetas) items.push({ tipo: 'carpeta', id: c, nombre: nombreHoja(c) });
    for (const aid of this.sel.archivos) {
      const a = this.archivos.find((x) => x.id === aid);
      items.push({ tipo: 'archivo', id: aid, nombre: a?.nombre ?? aid });
    }
    return items;
  }

  private enPointerMove(ev: PointerEvent) {
    if (!this.dragStart && !this.drag) return;
    if (this.dragStart && !this.drag) {
      const dx = ev.clientX - this.dragStart.x;
      const dy = ev.clientY - this.dragStart.y;
      if (Math.hypot(dx, dy) < 14) return;
      const items = this.itemsDeArrastre(this.dragStart.tipo, this.dragStart.id, this.dragStart.nombre);
      this.drag = {
        items,
        nombre: this.dragStart.nombre,
        x: ev.clientX,
        y: ev.clientY,
      };
      this.arrastreHecho = true;
      this.dragStart = null;
    }
    if (this.drag) {
      ev.preventDefault();
      this.drag = { ...this.drag, x: ev.clientX, y: ev.clientY };
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dest = el?.closest('[data-drop]') as HTMLElement | null;
      const val = dest?.dataset['drop'];
      this.destinoHover = val === undefined || val === null ? null : val;
      this.zone.run(() => this.cdr.detectChanges());
    }
  }

  private async enPointerUp() {
    const d = this.drag;
    const dest = this.destinoHover;
    this.dragStart = null;
    this.drag = null;
    this.destinoHover = null;
    this.zone.run(() => this.cdr.detectChanges());
    if (!d || dest == null) return;
    const carpetaDest = dest === '..' ? padreDe(this.ruta) : dest;
    try {
      for (const item of d.items) {
        if (item.tipo === 'archivo') {
          const a = this.todos.find((x) => x.id === item.id);
          if (a && normalizarRuta(a.carpeta) === normalizarRuta(carpetaDest)) continue;
          await this.archivosApi.actualizar(item.id, { carpeta: carpetaDest }, this.ccId);
        } else {
          const nuevo = unirRuta(carpetaDest, nombreHoja(item.id));
          if (nuevo === item.id || nuevo.startsWith(item.id + '/')) continue;
          await this.archivosApi.reubicarCarpeta(this.ccId, item.id, nuevo);
        }
      }
      this.limpiarSel();
      await this.cargar();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo mover.';
      this.cdr.detectChanges();
    }
  }

  tamanoCarpeta(ruta: string): string {
    const pref = normalizarRuta(ruta);
    const bytes = this.todos
      .filter((a) => {
        const k = normalizarRuta(a.carpeta);
        return k === pref || k.startsWith(pref + '/');
      })
      .reduce((acc, a) => acc + (Number(a.tamanoBytes) || 0), 0);
    return bytes ? tamanoHumano(bytes) : '0 KB';
  }

  fechaCarpeta(ruta: string): string {
    const pref = normalizarRuta(ruta);
    let max = 0;
    for (const a of this.todos) {
      const k = normalizarRuta(a.carpeta);
      if (k === pref || k.startsWith(pref + '/')) {
        const t = new Date(a.actualizadoEn || a.subidoEn).getTime();
        if (t > max) max = t;
      }
    }
    return max ? this.fechaCorta(new Date(max).toISOString()) : '—';
  }

  estadoDe(a: Archivo): string {
    if (this.archivosApi.procesando(a)) return 'Procesando';
    if (a.estadoIndexado === 'error' || a.estadoEscaneo === 'error') return 'Error';
    return 'Listo';
  }

  tamanoDe(a: Archivo): string {
    return tamanoHumano(a.tamanoBytes);
  }

  fechaCorta(iso?: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private async pedirTexto(header: string, placeholder: string, valor = ''): Promise<string | null> {
    const alert = await this.alerts.create({
      header,
      inputs: [{ name: 'nombre', type: 'text', placeholder, value: valor }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Aceptar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { data, role } = await alert.onDidDismiss();
    const nombre = String(data?.values?.nombre ?? '').trim();
    return role === 'confirm' && nombre ? nombre : null;
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
