// Stub de archiver para los tests.
//
// archiver v8 es ESM puro ("type": "module", sin default export). En producción
// se carga con require() y funciona (Node 20.19+/24 soportan require de ESM),
// pero el runtime de módulos de jest NO puede require()-arlo y el suite entero
// fallaba al cargar el grafo (app -> rutas -> controlador -> require("archiver")).
//
// Ninguna prueba ejercita la descarga .zip (ctrlDescargarCarpeta), así que basta
// con un ZipArchive de pega que cumpla la interfaz que usa el controlador para
// que el módulo cargue. Se enchufa vía moduleNameMapper en jest.config.js.
export class ZipArchive {
  on(): this {
    return this;
  }
  pipe(): this {
    return this;
  }
  append(): this {
    return this;
  }
  finalize(): Promise<void> {
    return Promise.resolve();
  }
}
