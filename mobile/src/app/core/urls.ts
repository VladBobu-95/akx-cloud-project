import { Capacitor } from '@capacitor/core';
import { environment } from '../../environments/environment';

// Punto único para las direcciones del backend. Los valores viven en
// environments/ (environment.prod.ts en ng build --configuration production).
type PorPlataforma = { web: string; android: string };

const segunPlataforma = (u: PorPlataforma): string =>
  Capacitor.getPlatform() === 'android' ? u.android : u.web;

/** API de ATEKA (sin barra final): `${atekaUrl()}/api/...` */
export const atekaUrl = (): string => segunPlataforma(environment.atekaUrl);

/** Gateway cloud-mid (sin barra final): `${gatewayUrl()}/gate` */
export const gatewayUrl = (): string => segunPlataforma(environment.gatewayUrl);
