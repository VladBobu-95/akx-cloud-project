import { createHmac } from "crypto";
import { Pool, types } from "pg";
import { env } from "./env";
import { AppDataSource } from "./database";

// Conexión SEPARADA con la que se ejecutan las consultas SQL que escribe el
// modelo del chat. Entra como el rol "ateka_chat" (migración 1779), que solo puede
// leer las vistas del esquema "chat". Tiene que ser un usuario de login propio:
// si reutilizáramos la conexión principal con SET ROLE, el propio SQL del modelo
// podría deshacerlo (RESET ROLE / set_config('role', ...)) y recuperar los
// permisos completos.

const ROL = "ateka_chat";

// Contraseña derivada de JWT_SECRET: no hace falta otra variable en .env y no se
// guarda en ninguna migración. Solo es hexadecimal, así que puede ir en el SQL.
const passwordChat = (): string =>
  createHmac("sha256", env.JWT_SECRET).update("ateka_chat_db").digest("hex");

// Cómo se convierten los valores de las filas. Fechas: tal cual las da Postgres
// (el parser por defecto crea un Date en hora local y un `date` puede cambiar de
// día). Numéricos (importes numeric, bigint, count): número JS, para que el
// modelo y la tabla del front los traten como cifras.
const OID = { int8: 20, numeric: 1700, date: 1082, timestamp: 1114, timestamptz: 1184 };
const tiposChat = {
  getTypeParser: ((oid: number, formato?: "text" | "binary") => {
    if (oid === OID.int8 || oid === OID.numeric) return (v: string) => Number(v);
    if (oid === OID.date || oid === OID.timestamp || oid === OID.timestamptz) {
      return (v: string) => v;
    }
    return types.getTypeParser(oid, formato);
  }) as typeof types.getTypeParser,
};

let pool: Pool | null = null;

// Al arrancar (tras las migraciones): activa el login del rol con la contraseña
// derivada. ALTER ROLE no admite parámetros, de ahí el literal.
export const prepararRolChat = async (): Promise<void> => {
  await AppDataSource.query(`ALTER ROLE ${ROL} WITH LOGIN PASSWORD '${passwordChat()}'`);
};

export const poolChat = (): Pool => {
  if (!pool) {
    pool = new Pool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: ROL,
      password: passwordChat(),
      database: env.DB_NAME,
      max: 5,
      // Tope del lado del cliente por si el servidor no corta a tiempo.
      query_timeout: 15_000,
      types: tiposChat,
    });
  }
  return pool;
};

export const cerrarPoolChat = async (): Promise<void> => {
  await pool?.end();
  pool = null;
};
