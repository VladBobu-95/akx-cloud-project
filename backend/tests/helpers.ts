import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { AppDataSource } from "../src/config/database";
import { Empresa } from "../src/entities/Empresa";
import { Usuario } from "../src/entities/Usuario";
import { env } from "../src/config/env";

export interface UsuarioTest {
  token: string;
  id: string;
  email: string;
  empresaId: string | null;
}

// Crea un usuario (y su empresa, salvo superadmin) directamente en BD y devuelve
// un token firmado. Sustituye al antiguo registro público en los tests (ya no
// existe `POST /api/auth/registro`). La contraseña siempre es "password123".
export const crearUsuario = async (
  email: string,
  opciones: {
    rol?: "superadmin" | "admin" | "miembro";
    empresaId?: string;
    estadoEmpresa?: "activa" | "suspendida";
  } = {},
): Promise<UsuarioTest> => {
  const rol = opciones.rol ?? "miembro";

  let empresaId: string | null = opciones.empresaId ?? null;
  if (!empresaId && rol !== "superadmin") {
    const empresa = await AppDataSource.getRepository(Empresa).save(
      AppDataSource.getRepository(Empresa).create({
        nombre: `Empresa ${email}`,
        estado: opciones.estadoEmpresa ?? "activa",
      }),
    );
    empresaId = empresa.id;
  }

  const passwordHash = await bcrypt.hash("password123", 12);
  const usuario = await AppDataSource.getRepository(Usuario).save(
    AppDataSource.getRepository(Usuario).create({
      email,
      nombre: "Test",
      passwordHash,
      rol,
      empresaId,
    }),
  );

  const token = jwt.sign(
    {
      sub: usuario.id,
      email: usuario.email,
      rol: usuario.rol,
      empresaId: usuario.empresaId ?? null,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return { token, id: usuario.id, email: usuario.email, empresaId };
};

// Atajo cuando solo se necesita el token de un miembro normal.
export const tokenUsuario = async (email: string): Promise<string> =>
  (await crearUsuario(email)).token;
