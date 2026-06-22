// Helpers puros para rutas de carpetas virtuales ("/", "/a/b").
// Sin estado ni dependencias de Angular/DOM → fáciles de testear y reutilizar.
// El componente (archivos.ts) los expone como miembros para usarlos en el template.

// Ruta canónica: '/' para la raíz, '/a/b' para anidadas.
export function normalizarRuta(carpeta: string): string {
  const limpia = (carpeta ?? '').replace(/^\/+|\/+$/g, '');
  return limpia ? '/' + limpia : '/';
}

export function segmentos(ruta: string): string[] {
  return ruta === '/' ? [] : ruta.slice(1).split('/');
}

export function unir(padreRuta: string, nombre: string): string {
  return padreRuta === '/' ? '/' + nombre : padreRuta + '/' + nombre;
}

export function padre(ruta: string): string {
  const segs = segmentos(ruta);
  segs.pop();
  return segs.length ? '/' + segs.join('/') : '/';
}

export function nombreHoja(ruta: string): string {
  return segmentos(ruta).at(-1) ?? 'Mis archivos';
}
