/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testMatch: ["**/tests/**/*.test.ts"],
  testTimeout: 30000,
  // ts-jest transpila cada fichero por separado (isolatedModules se toma del tsconfig).
  // El type-check serio del codigo fuente lo hace `tsc --noEmit` / `npm run build`.
  transform: {
    "^.+\\.ts$": ["ts-jest", {}],
  },
};
