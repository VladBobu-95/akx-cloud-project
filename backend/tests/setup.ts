import "reflect-metadata";
import { beforeAll, afterAll } from "@jest/globals";
import { Client } from "pg";
import { AppDataSource } from "../src/config/database";
import { inicializarBucket } from "../src/config/minio";
import { env } from "../src/config/env";

// Salvaguarda: NUNCA correr los tests contra la BD de desarrollo/produccion.
// El script de test fija DB_NAME=clouddrive_test y NODE_ENV=test.
if (env.NODE_ENV !== "test") {
  throw new Error(
    `Los tests deben correr con NODE_ENV=test (actual: "${env.NODE_ENV}"). Usa "npm test".`,
  );
}
// Doble salvaguarda: el TRUNCATE solo es seguro contra una BD claramente de test.
if (!env.DB_NAME.includes("test")) {
  throw new Error(
    `DB_NAME debe ser una base de datos de test (actual: "${env.DB_NAME}"). Abortando para no tocar datos reales.`,
  );
}

// Crea la BD de test si no existe, conectandose a la BD "postgres" por defecto.
const asegurarBdTest = async (): Promise<void> => {
  const admin = new Client({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  const existe = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [env.DB_NAME],
  );
  if (existe.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${env.DB_NAME}"`);
  }
  await admin.end();
};

beforeAll(async () => {
  await asegurarBdTest();
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize(); // synchronize=true crea el esquema
  }
  // Extensiones que en producción crean las migraciones (aquí usamos synchronize,
  // que no las ejecuta). Sin "unaccent" fallan los filtros de cliente/producto de
  // facturas (ILIKE unaccent(...)), que son parte de la funcionalidad probada.
  await AppDataSource.query("CREATE EXTENSION IF NOT EXISTS unaccent");
  await inicializarBucket();
  // Estado limpio en cada arranque de suite
  await AppDataSource.query(
    'TRUNCATE "archivos", "usuarios", "empresas" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
});
