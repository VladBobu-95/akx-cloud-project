import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface MensajeChat {
  rol: 'usuario' | 'bot';
  contenido: string;
}

export interface FilaFactura {
  archivoId: string | null;
  archivoNombre: string | null;
  fecha: string;
  total: number;
  moneda: string;
}

export interface FilaArchivo {
  id: string;
  nombre: string;
  carpeta: string;
  tamanoBytes: string;
  subidoEn: string;
}

// Tablas paginadas que puede devolver el chat. `pagina`/`totalPaginas` mandan; las
// de facturas/archivos piden las páginas siguientes a un endpoint REST reenviando
// `filtro`/`carpeta`. tablaCarpetas trae TODAS las filas y se pagina en memoria
// (la `pagina` la lleva el front).
export interface TablaFacturas {
  titulo: string;
  pagina: number;
  totalPaginas: number;
  total: number;
  limite: number;
  filtro: Record<string, unknown>;
  filas: FilaFactura[];
}

export interface TablaArchivos {
  titulo: string;
  carpeta?: string;
  pagina: number;
  totalPaginas: number;
  total: number;
  limite: number;
  filas: FilaArchivo[];
}

export interface TablaCarpetas {
  titulo: string;
  limite: number;
  pagina?: number; // estado local de paginación en memoria (el backend no la envía)
  filas: { ruta: string }[];
}

// Tabla clicable que acompaña a una pregunta de aclaración ("¿cuál quieres?" /
// "¿querías decir...?"). Al pulsar una fila se manda `valor` (para que la
// burbuja del chat lea bien) y, si la opción es un archivo, también `id` como
// `idOpcion` para resolverla SIN ambigüedad por id exacto (dos opciones pueden
// compartir el mismo nombre en carpetas distintas). `lectura` (a nivel de
// tabla: la tool es la misma para todas las opciones) decide si además del
// botón de elegir se ofrece "Abrir" (solo tiene sentido para tools de consulta
// como leer_archivo/obtener_factura, no para mover/copiar/eliminar...).
export interface TablaAclaracion {
  titulo: string;
  sugerencia: boolean;
  lectura: boolean;
  limite: number;
  pagina?: number; // estado local de paginación en memoria (el backend manda todas las filas)
  filas: { etiqueta: string; valor: string; id?: string }[];
}

// Mensaje tal y como lo muestra la UI.
export interface Mensaje {
  de: 'usuario' | 'bot';
  texto: string;
  archivos?: { id: string; nombre: string }[];
  tablaFacturas?: TablaFacturas;
  tablaArchivos?: TablaArchivos;
  tablaCarpetas?: TablaCarpetas;
  tablaAclaracion?: TablaAclaracion;
}

export interface RespuestaChat {
  respuesta: string;
  acciones: string[];
  archivos?: { id: string; nombre: string }[];
  tablaFacturas?: TablaFacturas;
  tablaArchivos?: TablaArchivos;
  tablaCarpetas?: TablaCarpetas;
  tablaAclaracion?: TablaAclaracion;
}

const CHAT_KEY = 'akx_chat';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/chat`;

  // El historial vive en el servicio (singleton), así sobrevive al cambiar de
  // página; además se persiste en localStorage para sobrevivir a recargas.
  readonly mensajes = signal<Mensaje[]>(this.cargar());

  // Texto que el usuario está escribiendo antes de enviar. Vive aquí (no en el
  // componente de la página) para que sobreviva al navegar a /archivos o
  // /papelera y volver, igual que el historial.
  readonly borrador = signal('');

  añadir(m: Mensaje) {
    this.mensajes.update((arr) => [...arr, m]);
    this.persistir();
  }

  // Reemplaza el mensaje en la posición dada (lo usa la paginación de las tablas
  // del chat para sustituir las filas/página de un mensaje ya pintado) y persiste.
  actualizarMensaje(index: number, m: Mensaje) {
    this.mensajes.update((arr) => arr.map((x, i) => (i === index ? m : x)));
    this.persistir();
  }

  // Páginas siguientes de una tabla de facturas del chat: mismo filtro que la 1ª
  // página (que vino ya resuelta por el chat), pedido al endpoint REST normal.
  masFacturas(filtro: Record<string, unknown>, pagina: number, limite: number) {
    let params = new HttpParams().set('pagina', pagina).set('limite', limite);
    for (const [clave, valor] of Object.entries(filtro)) {
      if (valor === null || valor === undefined || valor === '') continue;
      params = params.set(clave, Array.isArray(valor) ? valor.join(',') : String(valor));
    }
    return this.http.get<{ filas: FilaFactura[]; total: number; paginas: number }>(
      `${environment.apiUrl}/api/facturas`,
      { params },
    );
  }

  limpiar() {
    this.mensajes.set([]);
    this.persistir();
  }

  // Borra TODO el estado del chat: el historial y el borrador en memoria (este
  // servicio es un singleton que sobrevive al logout porque la SPA no recarga) y
  // también lo persistido en localStorage. Lo llama AuthService al cerrar sesión
  // y al iniciar una nueva, para que el chat de un usuario no se filtre al
  // siguiente que use el mismo navegador.
  reset() {
    this.mensajes.set([]);
    this.borrador.set('');
    localStorage.removeItem(CHAT_KEY);
  }

  // Envía el historial de la conversación y devuelve la respuesta del asistente.
  // `idOpcion` solo se manda cuando el mensaje es la elección de una fila de
  // tablaAclaracion pulsada como botón (ver TablaAclaracion).
  enviar(mensajes: MensajeChat[], idOpcion?: string) {
    return this.http.post<RespuestaChat>(this.base, { mensajes, idOpcion });
  }

  private cargar(): Mensaje[] {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      return raw ? (JSON.parse(raw) as Mensaje[]) : [];
    } catch {
      return [];
    }
  }
  private persistir() {
    localStorage.setItem(CHAT_KEY, JSON.stringify(this.mensajes()));
  }
}
