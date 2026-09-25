import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { IsNull } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../config/database";
import { ClaveApi } from "../entities/ClaveApi";
import { Usuario } from "../entities/Usuario";
import { AppError } from "../utils/errors";

const MAX_ACTIVAS = 5;
const PREFIJO_SECRETO = "ateka_live_";

export const schemaCrearClave = z.object({
  nombre: z.string().trim().min(1).max(60).optional(),
});

const repo = () => AppDataSource.getRepository(ClaveApi);

export const hashClave = (clave: string): string =>
  createHash("sha256").update(clave).digest("hex");

export const clavesIguales = (recibida: string, esperada: string): boolean => {
  const a = createHash("sha256").update(recibida).digest();
  const b = createHash("sha256").update(esperada).digest();
  return timingSafeEqual(a, b);
};

const generarSecreto = (): { clave: string; prefijo: string; hash: string } => {
  const clave = PREFIJO_SECRETO + randomBytes(24).toString("hex");
  return { clave, prefijo: clave.slice(0, 16), hash: hashClave(clave) };
};

const aPublica = (c: ClaveApi) => ({
  id: c.id,
  nombre: c.nombre,
  prefijo: c.prefijo,
  ultimoUso: c.ultimoUso,
  creadoEn: c.creadoEn,
});

export const listarClaves = async (usuarioId: string) => {
  const filas = await repo().find({
    where: { usuarioId, revocadaEn: IsNull() },
    order: { creadoEn: "DESC" },
  });
  return filas.map(aPublica);
};

export const crearClave = async (
  usuarioId: string,
  empresaId: string | null,
  nombre?: string,
) => {
  const activas = await repo().count({ where: { usuarioId, revocadaEn: IsNull() } });
  if (activas >= MAX_ACTIVAS) {
    throw new AppError(400, `Máximo ${MAX_ACTIVAS} claves activas. Revoca una para crear otra.`);
  }
  const { clave, prefijo, hash } = generarSecreto();
  const fila = repo().create({
    nombre: nombre?.trim() || "n8n",
    prefijo,
    hash,
    usuarioId,
    empresaId,
  });
  const guardada = await repo().save(fila);
  return { ...aPublica(guardada), clave };
};

export const revocarClave = async (usuarioId: string, id: string): Promise<void> => {
  const fila = await repo().findOne({ where: { id, usuarioId, revocadaEn: IsNull() } });
  if (!fila) throw new AppError(404, "Clave no encontrada");
  fila.revocadaEn = new Date();
  await repo().save(fila);
};

// Resuelve una X-Api-Key de BD al usuario dueño. Null si no existe o está revocada.
export const usuarioPorClaveBd = async (recibida: string): Promise<Usuario | null> => {
  const fila = await repo().findOne({
    where: { hash: hashClave(recibida), revocadaEn: IsNull() },
    relations: { usuario: true },
  });
  if (!fila?.usuario) return null;
  fila.ultimoUso = new Date();
  await repo().save(fila);
  return fila.usuario;
};
