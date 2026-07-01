import "reflect-metadata";
import path from "path";
import { DataSource, AdvancedConsoleLogger } from "typeorm";
import type { QueryRunner } from "typeorm";
import { env } from "./env";
import { Empresa } from "../entities/Empresa";
import { Rol } from "../entities/Rol";
import { CarpetaCompartida } from "../entities/CarpetaCompartida";
import { CarpetaCompartidaCarpeta } from "../entities/CarpetaCompartidaCarpeta";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { Carpeta } from "../entities/Carpeta";
import { Factura } from "../entities/Factura";
import { LineaFactura } from "../entities/LineaFactura";
import { Tarea } from "../entities/Tarea";
import { ChatPendiente } from "../entities/ChatPendiente";

// Logger de dev que silencia el sondeo del worker de la cola durable
// (tareas.service.ts): es un SELECT ... FOR UPDATE SKIP LOCKED cada pocos
// segundos que, junto a su START TRANSACTION/COMMIT, inundaría la consola sin
// aportar nada. Todo lo demás se loguea igual que el logger por defecto.
class LoggerSinSondeoWorker extends AdvancedConsoleLogger {
  private esRuidoDelWorker(query: string): boolean {
    return (
      query.includes("FOR UPDATE SKIP LOCKED") ||
      query === "START TRANSACTION" ||
      query === "COMMIT" ||
      query === "ROLLBACK"
    );
  }
  logQuery(query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
    if (this.esRuidoDelWorker(query)) return;
    super.logQuery(query, parameters, queryRunner);
  }
}

export const AppDataSource = new DataSource({
  type: "postgres",
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: [Empresa, Rol, CarpetaCompartida, CarpetaCompartidaCarpeta, Usuario, Archivo, Carpeta, Factura, LineaFactura, Tarea, ChatPendiente],
  migrations: [path.join(__dirname, "../migrations/*.{ts,js}")],
  migrationsTableName: "migrations",
  // Solo los tests autogeneran el esquema (synchronize). En dev/prod el esquema
  // se gestiona con migraciones controladas (migrationsRun las aplica al arrancar).
  synchronize: env.NODE_ENV === "test",
  migrationsRun: env.NODE_ENV !== "test",
  logging: env.NODE_ENV === "development", // logs SQL solo en desarrollo
  // En dev usamos un logger que omite el sondeo del worker (ver arriba).
  logger: env.NODE_ENV === "development" ? new LoggerSinSondeoWorker(true) : undefined,
});