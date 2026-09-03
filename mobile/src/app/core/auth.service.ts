import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { BehaviorSubject, from } from 'rxjs';
import { switchMap, tap, timeout } from 'rxjs/operators';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { environment } from '../../environments/environment';

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
  rol: string;
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

  login(email: string, password: string) {
    if (Capacitor.getPlatform() === 'android') {
      return from(this.loginAndroid(email, password)).pipe(
        timeout(15000),
        tap((r) => {
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
      timeout(12000),
      tap(async (r) => {
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
      CapacitorHttp.get({ url: `${PLESK_CONNECTED}/gate` }),
      8000,
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
      8000,
    );
    const loginData = typeof login.data === 'string' ? JSON.parse(login.data || '{}') : login.data;
    if (login.status !== 200) {
      throw new HttpErrorResponse({ status: login.status, error: loginData });
    }
    const r = loginData as LoginRes;
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
    return (http.error && http.error.error) || 'No se pudo iniciar sesión.';
  }

  async logout(): Promise<void> {
    await Preferences.remove({ key: TOKEN_KEY });
    await Preferences.remove({ key: USER_KEY });
    this.usuario.next(null);
    await this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
