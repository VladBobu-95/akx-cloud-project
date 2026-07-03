import bcrypt from "bcrypt";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../config/database";
import { Usuario } from "../entities/Usuario";
import { Rol } from "../entities/Rol";
import { Archivo } from "../entities/Archivo";
import { Empresa } from "../entities/Empresa";
import { AppError } from "../utils/errors";
import { CAPACIDADES, esCapacidadValida } from "../config/capacidades";
import { listarArchivos } from "./archivos.service";

// Gestión del EQUIPO de una empresa por su admin: miembros (usuarios), roles
// funcionales configurables y consulta de los archivos de cada miembro. Todo va
// scoped a la empresa del admin (empresaId), nunca cruza tenants.

const usuarioRepo = () => AppDataSource.getRepository(Usuario);
const rolRepo = () => AppDataSource.getRepository(Rol);
const empresaRepo = () => AppDataSource.getRepository(Empresa);

// --- Datos de la propia empresa del admin (nombre + CIF) ---
// El CIF ancla la clasificación venta/compra de las facturas; se auto-aprende al
// escanear (ver resolverDireccion) pero el admin puede verlo/corregirlo aquí.
export const schemaActualizarEmpresaPropia = z.object({
  // "" borra el CIF; undefined lo deja igual.
  nif: z.string().trim().optional(),
});

const empresaDTO = (e: Empresa) => ({ id: e.id, nombre: e.nombre, nif: e.nif ?? null });

export const obtenerEmpresaPropia = async (empresaId: string) => {
  const e = await empresaRepo().findOneBy({ id: empresaId });
  if (!e) throw new AppError(404, "Empresa no encontrada");
  return empresaDTO(e);
};

export const actualizarEmpresaPropia = async (
  empresaId: string,
  datos: z.infer<typeof schemaActualizarEmpresaPropia>,
) => {
  const e = await empresaRepo().findOneBy({ id: empresaId });
  if (!e) throw new AppError(404, "Empresa no encontrada");
  if (datos.nif !== undefined) e.nif = datos.nif.trim() || null;
  await empresaRepo().save(e);
  return empresaDTO(e);
};

// --- Vista pública de un miembro (sin hash) ---
interface MiembroDTO {
  id: string;
  email: string;
  nombre?: string;
  rol: string;
  roles: { id: string; nombre: string; capacidades: string[] }[];
  creadoEn: Date;
}

const aMiembroDTO = (u: Usuario): MiembroDTO => ({
  id: u.id,
  email: u.email,
  nombre: u.nombre,
  rol: u.rol,
  roles: (u.roles ?? []).map((r) => ({
    id: r.id,
    nombre: r.nombre,
    capacidades: r.capacidades ?? [],
  })),
  creadoEn: u.creadoEn,
});

// ===================== ROLES =====================

const capacidadesSchema = z
  .array(z.string())
  .refine((arr) => arr.every(esCapacidadValida), {
    message: `capacidades inválidas (permitidas: ${CAPACIDADES.join(", ")})`,
  });

export const schemaCrearRol = z.object({
  nombre: z.string().min(1, "el nombre del rol es obligatorio"),
  capacidades: capacidadesSchema.default([]),
});

export const schemaActualizarRol = z.object({
  nombre: z.string().min(1).optional(),
  capacidades: capacidadesSchema.optional(),
});

export const listarRoles = (empresaId: string): Promise<Rol[]> =>
  rolRepo().find({ where: { empresaId }, order: { nombre: "ASC" } });

export const crearRol = async (
  empresaId: string,
  datos: z.infer<typeof schemaCrearRol>,
): Promise<Rol> => {
  const existe = await rolRepo().findOneBy({ empresaId, nombre: datos.nombre });
  if (existe) throw new AppError(409, "Ya existe un rol con ese nombre");
  const rol = rolRepo().create({
    empresaId,
    nombre: datos.nombre,
    capacidades: datos.capacidades,
  });
  return rolRepo().save(rol);
};

export const actualizarRol = async (
  empresaId: string,
  rolId: string,
  datos: z.infer<typeof schemaActualizarRol>,
): Promise<Rol> => {
  const rol = await rolRepo().findOneBy({ id: rolId, empresaId });
  if (!rol) throw new AppError(404, "Rol no encontrado");
  if (datos.nombre !== undefined && datos.nombre !== rol.nombre) {
    const choca = await rolRepo().findOneBy({ empresaId, nombre: datos.nombre });
    if (choca) throw new AppError(409, "Ya existe un rol con ese nombre");
    rol.nombre = datos.nombre;
  }
  if (datos.capacidades !== undefined) rol.capacidades = datos.capacidades;
  return rolRepo().save(rol);
};

export const eliminarRol = async (empresaId: string, rolId: string): Promise<void> => {
  const rol = await rolRepo().findOneBy({ id: rolId, empresaId });
  if (!rol) throw new AppError(404, "Rol no encontrado");
  // Las filas de usuario_roles se borran por el FK ON DELETE CASCADE.
  await rolRepo().remove(rol);
};

// Resuelve y valida que los rolesIds pertenezcan a la empresa.
const resolverRoles = async (empresaId: string, rolesIds: string[]): Promise<Rol[]> => {
  if (rolesIds.length === 0) return [];
  const roles = await rolRepo().findBy({ id: In(rolesIds), empresaId });
  if (roles.length !== new Set(rolesIds).size) {
    throw new AppError(400, "Algún rol no existe o no pertenece a tu empresa");
  }
  return roles;
};

// ===================== MIEMBROS =====================

export const schemaCrearMiembro = z.object({
  nombre: z.string().min(1, "el nombre es obligatorio"),
  email: z.string().email("email inválido"),
  password: z.string().min(8, "la contraseña debe tener al menos 8 caracteres"),
  // Nivel de cuenta: el admin solo puede crear miembros u otros admins, nunca superadmin.
  rol: z.enum(["miembro", "admin"]).default("miembro"),
  rolesIds: z.array(z.string().uuid()).default([]),
});

export const schemaActualizarMiembro = z.object({
  nombre: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  rol: z.enum(["miembro", "admin"]).optional(),
  rolesIds: z.array(z.string().uuid()).optional(),
});

export const listarMiembros = async (empresaId: string): Promise<MiembroDTO[]> => {
  const usuarios = await usuarioRepo().find({
    where: { empresaId },
    relations: { roles: true },
    order: { creadoEn: "ASC" },
  });
  return usuarios.map(aMiembroDTO);
};

export const crearMiembro = async (
  empresaId: string,
  datos: z.infer<typeof schemaCrearMiembro>,
): Promise<MiembroDTO> => {
  const existe = await usuarioRepo().findOneBy({ email: datos.email });
  if (existe) throw new AppError(409, "El email ya está registrado");

  const roles = await resolverRoles(empresaId, datos.rolesIds);
  const passwordHash = await bcrypt.hash(datos.password, 12);

  const usuario = usuarioRepo().create({
    nombre: datos.nombre,
    email: datos.email,
    passwordHash,
    rol: datos.rol,
    empresaId,
    roles,
  });
  await usuarioRepo().save(usuario);
  return aMiembroDTO(usuario);
};

export const actualizarMiembro = async (
  empresaId: string,
  miembroId: string,
  datos: z.infer<typeof schemaActualizarMiembro>,
): Promise<MiembroDTO> => {
  const usuario = await usuarioRepo().findOne({
    where: { id: miembroId, empresaId },
    relations: { roles: true },
  });
  if (!usuario) throw new AppError(404, "Miembro no encontrado");

  if (datos.email !== undefined && datos.email !== usuario.email) {
    const choca = await usuarioRepo().findOneBy({ email: datos.email });
    if (choca) throw new AppError(409, "El email ya está registrado");
    usuario.email = datos.email;
  }
  if (datos.nombre !== undefined) usuario.nombre = datos.nombre;
  if (datos.rol !== undefined) usuario.rol = datos.rol;
  if (datos.password) usuario.passwordHash = await bcrypt.hash(datos.password, 12);
  if (datos.rolesIds !== undefined) {
    usuario.roles = await resolverRoles(empresaId, datos.rolesIds);
  }

  await usuarioRepo().save(usuario);
  return aMiembroDTO(usuario);
};

export const eliminarMiembro = async (
  empresaId: string,
  miembroId: string,
  adminId: string,
): Promise<void> => {
  if (miembroId === adminId) {
    throw new AppError(400, "No puedes eliminar tu propia cuenta");
  }
  const usuario = await usuarioRepo().findOneBy({ id: miembroId, empresaId });
  if (!usuario) throw new AppError(404, "Miembro no encontrado");
  await usuarioRepo().remove(usuario);
};

// Archivos de un miembro (vista del admin), reutilizando el listado normal.
export const archivosDeMiembro = async (
  empresaId: string,
  miembroId: string,
  carpeta?: string,
  pagina = 1,
  limite = 20,
): Promise<{ archivos: Archivo[]; total: number; paginas: number }> => {
  const miembro = await usuarioRepo().findOneBy({ id: miembroId, empresaId });
  if (!miembro) throw new AppError(404, "Miembro no encontrado");
  return listarArchivos(miembroId, carpeta, pagina, limite);
};

// ===================== CAPACIDADES =====================

// Unión de capacidades de los roles de un usuario. admin/superadmin = todas.
// (Lo consume el RBAC del chat en Fase 3.)
export const capacidadesDe = async (usuarioId: string): Promise<Set<string>> => {
  const usuario = await usuarioRepo().findOne({
    where: { id: usuarioId },
    relations: { roles: true },
  });
  if (!usuario) return new Set();
  if (usuario.rol === "admin" || usuario.rol === "superadmin") {
    return new Set(CAPACIDADES);
  }
  const caps = new Set<string>();
  for (const rol of usuario.roles ?? []) {
    for (const c of rol.capacidades ?? []) caps.add(c);
  }
  return caps;
};
