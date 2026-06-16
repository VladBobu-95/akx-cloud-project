import "reflect-metadata";
import path from "path";
import { DataSource } from "typeorm";
import { env } from "./env";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { Carpeta } from "../entities/Carpeta";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: [Usuario, Archivo, Carpeta, Factura, LineaFactura],
  migrations: [path.join(__dirname, "../migrations/*.{ts,js}")],
  migrationsTableName: "migrations",
  // Solo los tests autogeneran el esquema (synchronize). En dev/prod el esquema
  // se gestiona con migraciones controladas (migrationsRun las aplica al arrancar).
  synchronize: env.NODE_ENV === "test",
  migrationsRun: env.NODE_ENV !== "test",
  logging: env.NODE_ENV === "development", // logs SQL solo en desarrollo
});