import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { AppDataSource } from "../config/database";
import { Usuario } from "../entities/Usuario";
import { AppError } from "../utils/errors";
import { env } from "../config/env";

// Función auxiliar para obtener el repositorio de Usuario.
// Usamos una función en vez de una constante para evitar problemas
// de inicialización (la BD puede no estar lista cuando se importa el módulo).
const repo = () => AppDataSource.getRepository(Usuario);

// --- SCHEMAS DE VALIDACIÓN (Zod) ---
// Zod valida los datos que llegan del cliente antes de procesarlos.

export const schemaRegistro = z.object({
  email: z.string().email("email inválido"),
  password: z.string().min(8, "la contraseña debe tener al menos 8 caracteres"),
  nombre: z.string().min(1, "el nombre de usuario es obligatorio"),
  rol: z.enum(["user", "admin"]).default("user"),
});

export const schemaLogin = z.object({
  email: z.string().email("email inválido"),
  password: z.string().min(1, "la contraseña es obligatoria"),
});

// --- SERVICIO: REGISTRAR ---
export const registrar = async (
  datos: z.infer<typeof schemaRegistro>,
): Promise<{ usuario: Omit<Usuario, "passwordHash">; token: string }> => {
  // Comprobamos si el email ya está registrado
  const existe = await repo().findOneBy({ email: datos.email });
  if (existe) throw new AppError(409, "El email ya está registrado");

  // bcrypt.hash convierte la contraseña en un hash seguro.
  // El número 12 es el "salt rounds": cuanto más alto, más seguro pero más lento.
  const passwordHash = await bcrypt.hash(datos.password, 12);

  // Creamos el objeto Usuario y lo guardamos en la BD
  const usuario = repo().create({
    email: datos.email,
    nombre: datos.nombre,
    passwordHash,
    rol: datos.rol,
  });
  await repo().save(usuario);

  // Generamos el JWT con los datos que necesitaremos en cada petición
  const token = generarToken(usuario);

  // Devolvemos el usuario SIN el hash de la contraseña (nunca lo enviamos al cliente)
  const { passwordHash: _, ...usuarioSinHash } = usuario;
  return { usuario: usuarioSinHash, token };
};

// --- SERVICIO: LOGIN ---
export const login = async (
  datos: z.infer<typeof schemaLogin>,
): Promise<{ usuario: Omit<Usuario, "passwordHash">; token: string }> => {
  // Buscamos el usuario por email
  const usuario = await repo().findOneBy({ email: datos.email });

  // Si no existe o la contraseña es incorrecta, damos el mismo error genérico.
  // Nunca decimos "el email no existe" porque daría información al atacante.
  if (!usuario) throw new AppError(401, "Credenciales incorrectas");

  const passwordCorrecta = await bcrypt.compare(
    datos.password,
    usuario.passwordHash,
  );
  if (!passwordCorrecta) throw new AppError(401, "Credenciales incorrectas");

  const token = generarToken(usuario);

  const { passwordHash: _, ...usuarioSinHash } = usuario;
  return { usuario: usuarioSinHash, token };
};

// --- ACTUALIZAR PERFIL ---
export const schemaActualizarPerfil = z.object({
  nombre: z.string().min(1, "el nombre de usuario es obligatorio").optional(),
  avatar: z.string().optional(), // data URL base64 (o "" para quitar)
  password: z.string().min(8, "la contraseña debe tener al menos 8 caracteres").optional(),
});

export const actualizarPerfil = async (
  usuarioId: string,
  datos: z.infer<typeof schemaActualizarPerfil>,
): Promise<Omit<Usuario, "passwordHash">> => {
  const usuario = await repo().findOneBy({ id: usuarioId });
  if (!usuario) throw new AppError(404, "Usuario no encontrado");

  if (datos.nombre !== undefined) usuario.nombre = datos.nombre;
  // null borra la columna; undefined haría que TypeORM la ignore (no se borraría).
  if (datos.avatar !== undefined) usuario.avatar = datos.avatar || null;
  if (datos.password) usuario.passwordHash = await bcrypt.hash(datos.password, 12);

  await repo().save(usuario);

  const { passwordHash: _, ...usuarioSinHash } = usuario;
  return usuarioSinHash;
};

// --- HELPER: GENERAR TOKEN ---
const generarToken = (usuario: Usuario): string => {
  return jwt.sign(
    {
      sub: usuario.id, // "sub" (subject) es el campo estándar para el ID
      email: usuario.email,
      rol: usuario.rol,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }, // El token caduca en 7 días
  );
};
