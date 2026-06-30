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
// No hay auto-registro público: las cuentas se crean desde la plataforma
// (admins de empresa) o desde el equipo (miembros), con su propia validación.

export const schemaLogin = z.object({
  email: z.string().email("email inválido"),
  password: z.string().min(1, "la contraseña es obligatoria"),
});

// --- SERVICIO: LOGIN ---
export const login = async (
  datos: z.infer<typeof schemaLogin>,
): Promise<{ usuario: Omit<Usuario, "passwordHash">; token: string }> => {
  // Buscamos el usuario por email (con su empresa, para comprobar suspensión).
  const usuario = await repo().findOne({
    where: { email: datos.email },
    relations: { empresa: true },
  });

  // Si no existe o la contraseña es incorrecta, damos el mismo error genérico.
  // Nunca decimos "el email no existe" porque daría información al atacante.
  if (!usuario) throw new AppError(401, "Credenciales incorrectas");

  const passwordCorrecta = await bcrypt.compare(
    datos.password,
    usuario.passwordHash,
  );
  if (!passwordCorrecta) throw new AppError(401, "Credenciales incorrectas");

  // Empresa suspendida: el usuario existe y la clave es correcta, pero su tenant
  // está bloqueado por el superadmin. (El superadmin no tiene empresa: nunca entra aquí.)
  if (usuario.empresa && usuario.empresa.estado === "suspendida") {
    throw new AppError(403, "Tu empresa está suspendida. Contacta con el administrador.");
  }

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

// El avatar es un data-URL base64 en una columna `text`, aceptado hasta el
// límite de express.json (10 MB) sin validar que sea REALMENTE una imagen ni el
// tamaño decodificado (#10). Aquí comprobamos: formato data-URL, mime permitido,
// magic bytes coherentes con ese mime y tope de tamaño decodificado (2 MB). Sin
// esto se podía guardar cualquier cosa (texto/HTML gigante) como "avatar".
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const VALIDADORES_AVATAR: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

export const validarAvatar = (dataUrl: string): void => {
  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!m) throw new AppError(400, "El avatar debe ser una imagen en formato data URL base64.");
  const mime = m[1].toLowerCase();
  const validador = VALIDADORES_AVATAR[mime];
  if (!validador) throw new AppError(400, "Formato de avatar no permitido. Usa PNG, JPEG o WEBP.");
  // Buffer.from(base64) ignora espacios/saltos; nunca lanza (chars no válidos se descartan).
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length === 0) throw new AppError(400, "El avatar está vacío o no es base64 válido.");
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new AppError(400, "El avatar es demasiado grande (máximo 2 MB).");
  }
  if (!validador(buffer)) {
    throw new AppError(400, "El contenido del avatar no coincide con una imagen válida.");
  }
};

export const actualizarPerfil = async (
  usuarioId: string,
  datos: z.infer<typeof schemaActualizarPerfil>,
): Promise<Omit<Usuario, "passwordHash">> => {
  const usuario = await repo().findOneBy({ id: usuarioId });
  if (!usuario) throw new AppError(404, "Usuario no encontrado");

  if (datos.nombre !== undefined) usuario.nombre = datos.nombre;
  // null borra la columna; undefined haría que TypeORM la ignore (no se borraría).
  // "" quita el avatar; cualquier otro valor debe ser una imagen válida.
  if (datos.avatar !== undefined) {
    if (datos.avatar) validarAvatar(datos.avatar);
    usuario.avatar = datos.avatar || null;
  }
  if (datos.password) usuario.passwordHash = await bcrypt.hash(datos.password, 12);

  await repo().save(usuario);

  const { passwordHash: _, ...usuarioSinHash } = usuario;
  return usuarioSinHash;
};

// --- HELPER: GENERAR TOKEN ---
// El rol de cuenta y la empresa van en el token (cambian poco). Los roles
// FUNCIONALES no van aquí: se consultan en BD por petición para que un cambio de
// permisos surta efecto sin esperar a que caduque el token (7 días).
const generarToken = (usuario: Usuario): string => {
  return jwt.sign(
    {
      sub: usuario.id, // "sub" (subject) es el campo estándar para el ID
      email: usuario.email,
      rol: usuario.rol,
      empresaId: usuario.empresaId ?? null,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }, // El token caduca en 7 días
  );
};
