import bcrypt from "bcrypt";
import { AppDataSource } from "../config/database";
import { Usuario } from "../entities/Usuario";
import { env } from "../config/env";

// Siembra el superadmin de la plataforma al arrancar, si no existe ninguno.
// Es el único usuario que se crea sin pasar por otro (no hay auto-registro): el
// resto los crea el superadmin (admins de empresa) o el admin (miembros). Idempotente.
export const sembrarSuperadmin = async (): Promise<void> => {
  const repo = AppDataSource.getRepository(Usuario);

  const existe = await repo.findOneBy({ rol: "superadmin" });
  if (existe) return;

  if (!env.SUPERADMIN_EMAIL || !env.SUPERADMIN_PASSWORD) {
    console.warn(
      "[seed] No hay superadmin y SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD no están definidos: " +
        "nadie podrá dar de alta empresas. Define ambos en .env y reinicia.",
    );
    return;
  }

  // No pisar un email ya en uso por otra cuenta.
  const emailUsado = await repo.findOneBy({ email: env.SUPERADMIN_EMAIL });
  if (emailUsado) {
    console.warn(
      `[seed] SUPERADMIN_EMAIL (${env.SUPERADMIN_EMAIL}) ya existe con rol "${emailUsado.rol}"; ` +
        "no se siembra superadmin.",
    );
    return;
  }

  const passwordHash = await bcrypt.hash(env.SUPERADMIN_PASSWORD, 12);
  const superadmin = repo.create({
    email: env.SUPERADMIN_EMAIL,
    nombre: "Superadmin",
    passwordHash,
    rol: "superadmin",
    empresaId: null,
  });
  await repo.save(superadmin);
  console.log(`[seed] Superadmin creado: ${env.SUPERADMIN_EMAIL}`);
};
