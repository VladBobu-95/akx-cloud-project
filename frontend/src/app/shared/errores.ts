import { HttpErrorResponse } from '@angular/common/http';

// Extrae un mensaje legible de los errores del backend.
// El backend responde { error: "..." } o { error, detalles: [{campo, mensaje}] }.
export function mensajeError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (body?.detalles?.length) {
      const mensajes = body.detalles.map((d: { mensaje: string }) => d.mensaje).join(', ');
      return mensajes.charAt(0).toUpperCase() + mensajes.slice(1);
    }
    if (body?.error) return body.error;
    if (err.status === 0) return 'No se puede conectar con el servidor';
    return `Error ${err.status}`;
  }
  return 'Ha ocurrido un error inesperado';
}
