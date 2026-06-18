/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testMatch: ["**/tests/**/*.test.ts"],
  testTimeout: 30000,
  // archiver v8 es ESM puro y el runtime de jest no puede require()-arlo (en
  // producción sí funciona, Node 20.19+). Como ninguna prueba usa la descarga
  // .zip, lo sustituimos por un stub para que el grafo de módulos cargue.
  moduleNameMapper: {
    "^archiver$": "<rootDir>/tests/mocks/archiver.ts",
  },
  // ts-jest transpila cada fichero por separado (isolatedModules se toma del tsconfig).
  // El type-check serio del codigo fuente lo hace `tsc --noEmit` / `npm run build`.
  transform: {
    "^.+\\.ts$": ["ts-jest", {}],
  },
};
