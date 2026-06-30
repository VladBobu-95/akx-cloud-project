import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { EquipoService } from '../../core/equipo.service';
import { CompartidoService } from '../../core/compartido.service';
import { ToastService } from '../../core/toast.service';
import { Archivo, CarpetaCompartida, Miembro, Rol } from '../../core/models';
import { FileSizePipe } from '../../shared/file-size.pipe';
import { mensajeError } from '../../shared/errores';

@Component({
  selector: 'app-equipo',
  imports: [DatePipe, FileSizePipe, FormsModule],
  templateUrl: './equipo.html',
  styleUrl: './equipo.scss',
})
export class EquipoPage {
  private svc = inject(EquipoService);
  private compartidoSvc = inject(CompartidoService);
  private toast = inject(ToastService);

  // Etiquetas legibles del vocabulario fijo de capacidades.
  protected readonly CAP_LABELS: Record<string, string> = {
    facturas: 'Facturas (escanear, listar, analítica)',
    busqueda: 'Búsqueda de archivos (RAG)',
    gestion_archivos: 'Gestión de archivos',
    chat: 'Usar el chatbot',
  };

  protected vista = signal<'miembros' | 'roles' | 'compartido'>('miembros');
  protected cargando = signal(false);
  protected guardando = signal(false);

  protected miembros = signal<Miembro[]>([]);
  protected roles = signal<Rol[]>([]);
  protected capacidades = signal<string[]>([]);
  protected compartidas = signal<CarpetaCompartida[]>([]);

  // ---- Modal carpeta compartida ----
  protected cMostrar = signal(false);
  protected cEditId = signal<string | null>(null);
  protected cNombre = '';
  protected cRolesSel = signal<Set<string>>(new Set());

  protected confirmacion = signal<{ titulo: string; mensaje: string; onOk: () => void } | null>(null);

  // ---- Modal miembro ----
  protected mMostrar = signal(false);
  protected mEditId = signal<string | null>(null);
  protected mNombre = '';
  protected mEmail = '';
  protected mPassword = '';
  protected mRolCuenta: 'miembro' | 'admin' = 'miembro';
  protected mRolesSel = signal<Set<string>>(new Set());

  // ---- Modal rol ----
  protected rMostrar = signal(false);
  protected rEditId = signal<string | null>(null);
  protected rNombre = '';
  protected rCapsSel = signal<Set<string>>(new Set());

  // ---- Vista de archivos de un miembro ----
  protected miembroVer = signal<Miembro | null>(null);
  protected archivosMiembro = signal<Archivo[]>([]);
  protected cargandoArchivos = signal(false);

  protected nombreCapacidad = (c: string) => this.CAP_LABELS[c] ?? c;

  constructor() {
    this.cargar();
  }

  cargar() {
    this.cargando.set(true);
    forkJoin({
      miembros: this.svc.listarMiembros(),
      roles: this.svc.listarRoles(),
      capacidades: this.svc.listarCapacidades(),
      compartidas: this.compartidoSvc.listarAdmin(),
    }).subscribe({
      next: (r) => {
        this.miembros.set(r.miembros);
        this.roles.set(r.roles);
        this.capacidades.set(r.capacidades);
        this.compartidas.set(r.compartidas);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  // ===================== MIEMBROS =====================
  abrirCrearMiembro() {
    this.mEditId.set(null);
    this.mNombre = '';
    this.mEmail = '';
    this.mPassword = '';
    this.mRolCuenta = 'miembro';
    this.mRolesSel.set(new Set());
    this.mMostrar.set(true);
  }

  abrirEditarMiembro(m: Miembro) {
    this.mEditId.set(m.id);
    this.mNombre = m.nombre ?? '';
    this.mEmail = m.email;
    this.mPassword = '';
    this.mRolCuenta = m.rol;
    this.mRolesSel.set(new Set(m.roles.map((r) => r.id)));
    this.mMostrar.set(true);
  }

  toggleRolMiembro(id: string) {
    const s = new Set(this.mRolesSel());
    s.has(id) ? s.delete(id) : s.add(id);
    this.mRolesSel.set(s);
  }

  guardarMiembro() {
    if (!this.mNombre || !this.mEmail) return;
    const editId = this.mEditId();
    if (!editId && !this.mPassword) return; // contraseña obligatoria al crear

    this.guardando.set(true);
    const rolesIds = [...this.mRolesSel()];

    if (editId) {
      const datos: {
        nombre: string;
        email: string;
        rol: 'miembro' | 'admin';
        rolesIds: string[];
        password?: string;
      } = { nombre: this.mNombre, email: this.mEmail, rol: this.mRolCuenta, rolesIds };
      if (this.mPassword) datos.password = this.mPassword;
      this.svc.actualizarMiembro(editId, datos).subscribe({
        next: () => this.trasGuardarMiembro('Miembro actualizado'),
        error: (err) => this.errorGuardando(err),
      });
    } else {
      this.svc
        .crearMiembro({
          nombre: this.mNombre,
          email: this.mEmail,
          password: this.mPassword,
          rol: this.mRolCuenta,
          rolesIds,
        })
        .subscribe({
          next: () => this.trasGuardarMiembro('Miembro creado'),
          error: (err) => this.errorGuardando(err),
        });
    }
  }

  private trasGuardarMiembro(msg: string) {
    this.guardando.set(false);
    this.mMostrar.set(false);
    this.toast.exito(msg);
    this.cargar();
  }

  private errorGuardando(err: unknown) {
    this.guardando.set(false);
    this.toast.error(mensajeError(err));
  }

  eliminarMiembro(m: Miembro) {
    this.confirmacion.set({
      titulo: 'Eliminar miembro',
      mensaje: `Eliminar a "${m.nombre || m.email}" borrará su cuenta y sus archivos. No se puede deshacer.`,
      onOk: () =>
        this.svc.eliminarMiembro(m.id).subscribe({
          next: () => {
            this.toast.exito('Miembro eliminado');
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }

  // ===================== ROLES =====================
  abrirCrearRol() {
    this.rEditId.set(null);
    this.rNombre = '';
    this.rCapsSel.set(new Set());
    this.rMostrar.set(true);
  }

  abrirEditarRol(r: Rol) {
    this.rEditId.set(r.id);
    this.rNombre = r.nombre;
    this.rCapsSel.set(new Set(r.capacidades));
    this.rMostrar.set(true);
  }

  toggleCapRol(cap: string) {
    const s = new Set(this.rCapsSel());
    s.has(cap) ? s.delete(cap) : s.add(cap);
    this.rCapsSel.set(s);
  }

  guardarRol() {
    if (!this.rNombre) return;
    this.guardando.set(true);
    const capacidades = [...this.rCapsSel()];
    const editId = this.rEditId();

    const obs = editId
      ? this.svc.actualizarRol(editId, { nombre: this.rNombre, capacidades })
      : this.svc.crearRol({ nombre: this.rNombre, capacidades });

    obs.subscribe({
      next: () => {
        this.guardando.set(false);
        this.rMostrar.set(false);
        this.toast.exito(editId ? 'Rol actualizado' : 'Rol creado');
        this.cargar();
      },
      error: (err) => this.errorGuardando(err),
    });
  }

  eliminarRol(r: Rol) {
    this.confirmacion.set({
      titulo: 'Eliminar rol',
      mensaje: `Eliminar el rol "${r.nombre}". Los miembros que lo tengan dejarán de tenerlo.`,
      onOk: () =>
        this.svc.eliminarRol(r.id).subscribe({
          next: () => {
            this.toast.exito('Rol eliminado');
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }

  // ===================== CARPETAS COMPARTIDAS =====================
  abrirCrearCompartida() {
    this.cEditId.set(null);
    this.cNombre = '';
    this.cRolesSel.set(new Set());
    this.cMostrar.set(true);
  }

  abrirEditarCompartida(c: CarpetaCompartida) {
    this.cEditId.set(c.id);
    this.cNombre = c.nombre;
    this.cRolesSel.set(new Set((c.roles ?? []).map((r) => r.id)));
    this.cMostrar.set(true);
  }

  toggleRolCompartida(id: string) {
    const s = new Set(this.cRolesSel());
    s.has(id) ? s.delete(id) : s.add(id);
    this.cRolesSel.set(s);
  }

  resumenRolesCompartida(c: CarpetaCompartida): string {
    return c.roles && c.roles.length ? c.roles.map((r) => r.nombre).join(', ') : 'Ningún rol (nadie accede)';
  }

  guardarCompartida() {
    if (!this.cNombre) return;
    this.guardando.set(true);
    const rolesIds = [...this.cRolesSel()];
    const editId = this.cEditId();
    const obs = editId
      ? this.compartidoSvc.actualizar(editId, { nombre: this.cNombre, rolesIds })
      : this.compartidoSvc.crear({ nombre: this.cNombre, rolesIds });
    obs.subscribe({
      next: () => {
        this.guardando.set(false);
        this.cMostrar.set(false);
        this.toast.exito(editId ? 'Carpeta compartida actualizada' : 'Carpeta compartida creada');
        this.cargar();
      },
      error: (err) => this.errorGuardando(err),
    });
  }

  eliminarCompartida(c: CarpetaCompartida) {
    this.confirmacion.set({
      titulo: 'Eliminar carpeta compartida',
      mensaje: `Eliminar "${c.nombre}" borrará todos sus archivos para todos los usuarios. No se puede deshacer.`,
      onOk: () =>
        this.compartidoSvc.eliminar(c.id).subscribe({
          next: () => {
            this.toast.exito('Carpeta compartida eliminada');
            this.cargar();
          },
          error: (err) => this.toast.error(mensajeError(err)),
        }),
    });
  }

  // ===================== ARCHIVOS DE MIEMBRO =====================
  verArchivos(m: Miembro) {
    this.miembroVer.set(m);
    this.cargandoArchivos.set(true);
    this.archivosMiembro.set([]);
    this.svc.archivosDeMiembro(m.id).subscribe({
      next: (r) => {
        this.archivosMiembro.set(r.archivos);
        this.cargandoArchivos.set(false);
      },
      error: (err) => {
        this.cargandoArchivos.set(false);
        this.toast.error(mensajeError(err));
      },
    });
  }

  cerrarArchivos() {
    this.miembroVer.set(null);
    this.archivosMiembro.set([]);
  }

  ejecutarConfirmacion() {
    const c = this.confirmacion();
    this.confirmacion.set(null);
    c?.onOk();
  }

  // Resumen de capacidades de un rol para la lista.
  protected resumenCaps(r: Rol): string {
    return r.capacidades.length
      ? r.capacidades.map((c) => this.nombreCapacidad(c)).join(', ')
      : '—';
  }
}
