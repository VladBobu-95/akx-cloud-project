import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { BehaviorSubject, firstValueFrom, from } from 'rxjs';
import { switchMap, tap, timeout } from 'rxjs/operators';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { environment } from '../../environments/environment';
import { idDispositivo } from './dispositivo';
import { ChatService } from './chat.service';

const PLESK_CONNECTED = 'https://mid-cloud.akx-server.es/connected';

const filtroUrl = (): string => {
  if (Capacitor.getPlatform() === 'android') return PLESK_CONNECTED;
  return environment.apiUrl;
};

const atekaUrl = (): string => {
  if (Capacitor.getPlatform() === 'android') return 'http://10.0.2.2:3000';
  return 'http://localhost:3000';
};

export type Usuario = {
  id: string;
  email: string;
  nombre?: string;
  avatar?: string | null;
  rol: string;
  creadoEn?: string;
  capacidades?: string[];
};

type LoginRes = { usuario: Usuario; token: string };

const TOKEN_KEY = 'akx_mobile_token';
const USER_KEY = 'akx_mobile_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private get base(): string {
    return `${atekaUrl()}/api/auth`;
  }
  readonly usuario = new BehaviorSubject<Usuario | null>(null);

  constructor(
    private http: HttpClient,
    private router: Router,
    private chat: ChatService,
  ) {}

  async hidratar(): Promise<void> {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    const user = await Preferences.get({ key: USER_KEY });
    if (value && user.value) {
      try {
        this.usuario.next(JSON.parse(user.value) as Usuario);
      } catch {
        this.usuario.next(null);
      }
    }
  }

  async token(): Promise<string | null> {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    return value;
  }

  estaAutenticado(): boolean {
    return this.usuario.value !== null;
  }

  esAdmin(): boolean {
    return this.usuario.value?.rol === 'admin';
  }

  esSuperadmin(): boolean {
    return this.usuario.value?.rol === 'superadmin';
  }

  private async guardarUsuario(u: Usuario): Promise<void> {
    await Preferences.set({ key: USER_KEY, value: JSON.stringify(u) });
    this.usuario.next(u);
  }

  async refrescarPerfil(): Promise<Usuario | null> {
    const token = await this.token();
    if (!token) return this.usuario.value;
    const r = await CapacitorHttp.get({
      url: `${this.base}/perfil`,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    const u = data?.usuario as Usuario;
    if (u) await this.guardarUsuario(u);
    return u ?? this.usuario.value;
  }

  async actualizarPerfil(datos: { nombre?: string; avatar?: string; password?: string }): Promise<Usuario> {
    const token = await this.token();
    const r = await CapacitorHttp.patch({
      url: `${this.base}/perfil`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: datos,
    });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    const u = data?.usuario as Usuario;
    if (u) await this.guardarUsuario(u);
    return u;
  }

  async obtenerEmpresa(): Promise<{ id: string; nombre: string; nif: string | null }> {
    const token = await this.token();
    const r = await CapacitorHttp.get({
      url: `${atekaUrl()}/api/equipo/empresa`,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    return data;
  }

  async actualizarEmpresa(datos: { nif?: string }): Promise<{ id: string; nombre: string; nif: string | null }> {
    const token = await this.token();
    const r = await CapacitorHttp.patch({
      url: `${atekaUrl()}/api/equipo/empresa`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: datos,
    });
    const data = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (r.status < 200 || r.status >= 300) {
      throw new Error((data && data.error) || `Error ${r.status}`);
    }
    return data;
  }

  login(email: string, password: string) {
    if (Capacitor.getPlatform() === 'android') {
      return from(this.loginAndroid(email, password)).pipe(
        timeout(35000),
        tap((r) => {
          this.cerrandoSesion = false;
          this.usuario.next(r.usuario);
        }),
      );
    }
    return this.http.get<{ ok: boolean; error?: string; ip?: string }>(`${filtroUrl()}/gate`).pipe(
      switchMap((g) => {
        if (g && g.ok === false) {
          throw new HttpErrorResponse({ status: 403, error: g });
        }
        return this.http.post<LoginRes>(`${this.base}/login`, { email, password });
      }),
      timeout(35000),
      tap(async (r) => {
        this.cerrandoSesion = false;
        await Preferences.set({ key: TOKEN_KEY, value: r.token });
        await Preferences.set({ key: USER_KEY, value: JSON.stringify(r.usuario) });
        this.usuario.next(r.usuario);
      }),
    );
  }

  private conTope<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => {
        setTimeout(() => rej(Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })), ms);
      }),
    ]);
  }

  private async loginAndroid(email: string, password: string): Promise<LoginRes> {
    const gate = await this.conTope(
      CapacitorHttp.get({
        url: `${PLESK_CONNECTED}/gate`,
      }),
      15000,
    );
    console.log('[login] gate status', gate.status, gate.data);
    const gateData = typeof gate.data === 'string' ? JSON.parse(gate.data || '{}') : gate.data || {};
    if (gateData && gateData.ok === false) {
      throw new HttpErrorResponse({ status: 403, error: gateData });
    }
    if (gate.status === 403) {
      throw new HttpErrorResponse({ status: 403, error: gateData });
    }
    if (gate.status < 200 || gate.status >= 300) {
      throw new HttpErrorResponse({ status: gate.status, error: gateData });
    }

    const login = await this.conTope(
      CapacitorHttp.post({
        url: `${atekaUrl()}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { email, password },
      }),
      15000,
    );
    const loginData = typeof login.data === 'string' ? JSON.parse(login.data || '{}') : login.data;
    if (login.status !== 200) {
      throw new HttpErrorResponse({ status: login.status, error: loginData });
    }
    const r = loginData as LoginRes;
    this.cerrandoSesion = false;
    await Preferences.set({ key: TOKEN_KEY, value: r.token });
    await Preferences.set({ key: USER_KEY, value: JSON.stringify(r.usuario) });
    return r;
  }

  mensajeError(err: unknown): string {
    const nombre = err && typeof err === 'object' ? (err as { name?: string }).name : '';
    if (nombre === 'TimeoutError') return 'El servidor tardó demasiado.';
    const http = err as HttpErrorResponse;
    if (http.status === 403) {
      const msg = (http.error && http.error.error) || 'Acceso bloqueado por el filtro.';
      const ip = http.error && http.error.ip;
      return ip ? `${msg} (IP ${ip})` : msg;
    }
    if (http.status === 401) return 'Credenciales incorrectas.';
    if (http.status === 0) return 'No hay conexión con el gateway.';
    const raw = err && typeof err === 'object' ? JSON.stringify(err) : String(err ?? '');
    if (raw.includes('UnknownHostException') || raw.includes('Unable to resolve host')) {
      return 'No hay conexión con el gateway (el emulador no tiene DNS/Internet).';
    }
    return (http.error && http.error.error) || 'No se pudo iniciar sesión.';
  }

  private cerrandoSesion = false;
  private pingEnVuelo: Promise<unknown> | null = null;

  async pingFiltro(): Promise<{ ok: boolean; motivo?: string; ip?: string }> {
    if (this.cerrandoSesion) return { ok: true };
    const p = this.hacerPing();
    this.pingEnVuelo = p;
    try {
      return await p;
    } finally {
      if (this.pingEnVuelo === p) this.pingEnVuelo = null;
    }
  }

  private async hacerPing(): Promise<{ ok: boolean; motivo?: string; ip?: string }> {
    try {
      if (this.cerrandoSesion) return { ok: true };
      const deviceId = await idDispositivo();
      const token = await this.token();
      const headers: Record<string, string> = { 'X-Device-Id': deviceId };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      let data: { ok?: boolean; motivo?: string; ip?: string } = {};
      if (Capacitor.getPlatform() === 'android') {
        const gate = await this.conTope(
          CapacitorHttp.get({
            url: `${PLESK_CONNECTED}/gate`,
            headers,
          }),
          8000,
        );
        data = typeof gate.data === 'string' ? JSON.parse(gate.data || '{}') : gate.data || {};
        if (this.cerrandoSesion) return { ok: true };
        if (gate.status === 403) return { ok: false, motivo: data.motivo, ip: data.ip };
      } else {
        data = await firstValueFrom(
          this.http.get<{ ok?: boolean; motivo?: string; ip?: string }>(`${filtroUrl()}/gate`, {
            headers,
          }).pipe(timeout(8000)),
        );
        if (this.cerrandoSesion) return { ok: true };
      }
      if (data && data.ok === false) return { ok: false, motivo: data.motivo, ip: data.ip };
      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  mensajeBloqueo(motivo?: string, ip?: string): string {
    if (motivo === 'ip_deny' || motivo === 'ip_not_allow') {
      return ip ? `Tu IP ha sido bloqueada (${ip}).` : 'Tu IP ha sido bloqueada.';
    }
    if (motivo === 'pais_deny' || motivo === 'pais_not_allow') {
      return 'El acceso desde tu país ha sido bloqueado.';
    }
    return 'Acceso bloqueado por el filtro.';
  }

  async logout(): Promise<void> {
    this.cerrandoSesion = true;
    try {
      await this.pingEnVuelo;
    } catch {
      /* el ping en vuelo no debe bloquear el logout */
    }
    await this.avisarSalida();
    await this.chat.reset();
    await Preferences.remove({ key: TOKEN_KEY });
    await Preferences.remove({ key: USER_KEY });
    this.usuario.next(null);
    await this.router.navigateByUrl('/login', { replaceUrl: true });
    await this.avisarSalida();
  }

  private async avisarSalida(): Promise<void> {
    const deviceId = await idDispositivo();
    const headers = { 'X-Device-Id': deviceId };
    const q = `device=${encodeURIComponent(deviceId)}`;
    const una = async (): Promise<void> => {
      if (Capacitor.getPlatform() === 'android') {
        await this.conTope(
          CapacitorHttp.get({ url: `${PLESK_CONNECTED}/salida?${q}`, headers }),
          8000,
        );
        return;
      }
      await firstValueFrom(
        this.http.get(`${filtroUrl()}/salida?${q}`, { headers }).pipe(timeout(8000)),
      );
    };
    try {
      await una();
    } catch {
      try {
        await una();
      } catch {
        /* el panel caducará por la ventana si Plesk no responde */
      }
    }
  }
}
