import bcrypt from "bcrypt";
import { z } from "zod";
import { AppDataSource } from "../config/database";
import { Empresa } from "../entities/Empresa";
import { Usuario } from "../entities/Usuario";
import { Archivo } from "../entities/Archivo";
import { minioClient } from "../config/minio";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

// Gestión de empresas (tenants) por el superadmin de la plataforma. Es la vía de
// alta de venta: crear una empresa junto con su primer admin, listarlas,
// suspender/reactivar y borrar.

const empresaRepo = () => AppDataSource.getRepository(Empresa);
const usuarioRepo = () => AppDataSource.getRepository(Usuario);

export const schemaCrearEmpresa = z.object({
  nombre: z.string().min(1, "el nombre de la empresa es obligatorio"),
  admin: z.object({
    email: z.string().email("email inválido"),
    password: z.string().min(8, "la contraseña debe tener al menos 8 caracteres"),
    nombre: z.string().min(1, "el nombre del admin es obligatorio"),
  }),
});

export const schemaActualizarEmpresa = z.object({
  nombre: z.string().min(1, "el nombre no puede estar vacío").optional(),
  estado: z.enum(["activa", "suspendida"]).optional(),
});

// Lista de empresas con el número de usuarios de cada una (para el panel).
export const listarEmpresas = async (): Promise<
  (Empresa & { usuariosCount: number })[]
> => {
  const empresas = await empresaRepo().find({ order: { creadoEn: "DESC" } });

  const counts = await usuarioRepo()
    .createQueryBuilder("u")
    .select("u.empresaId", "empresaId")
    .addSelect("COUNT(*)", "n")
    .where("u.empresaId IS NOT NULL")
    .groupBy("u.empresaId")
    .getRawMany<{ empresaId: string; n: string }>();

  const mapa = new Map(counts.map((c) => [c.empresaId, Number(c.n)]));
  return empresas.map((e) => ({ ...e, usuariosCount: mapa.get(e.id) ?? 0 }));
};

// Crea la empresa y su primer admin en una transacción (todo o nada).
export const crearEmpresaConAdmin = async (
  datos: z.infer<typeof schemaCrearEmpresa>,
): Promise<{ empresa: Empresa; admin: Omit<Usuario, "passwordHash"> }> => {
  // El email es único global (constraint UQ_usuarios_email).
  const existe = await usuarioRepo().findOneBy({ email: datos.admin.email });
  if (existe) throw new AppError(409, "El email del admin ya está registrado");

  return AppDataSource.transaction(async (manager) => {
    const empresa = manager.create(Empresa, {
      nombre: datos.nombre,
      estado: "activa",
    });
    await manager.save(empresa);

    const passwordHash = await bcrypt.hash(datos.admin.password, 12);
    const admin = manager.create(Usuario, {
      email: datos.admin.email,
      nombre: datos.admin.nombre,
      passwordHash,
      rol: "admin",
      empresaId: empresa.id,
    });
    await manager.save(admin);

    const { passwordHash: _omitido, ...adminSinHash } = admin;
    return { empresa, admin: adminSinHash };
  });
};

export const actualizarEmpresa = async (
  id: string,
  datos: z.infer<typeof schemaActualizarEmpresa>,
): Promise<Empresa> => {
  const empresa = await empresaRepo().findOneBy({ id });
  if (!empresa) throw new AppError(404, "Empresa no encontrada");

  if (datos.nombre !== undefined) empresa.nombre = datos.nombre;
  if (datos.estado !== undefined) empresa.estado = datos.estado;
  await empresaRepo().save(empresa);
  return empresa;
};

// Borra la empresa. El FK ON DELETE CASCADE arrastra usuarios y, por sus propios
// CASCADE, sus archivos/carpetas/facturas en BD. Los binarios en MinIO NO caen por
// CASCADE (viven fuera de Postgres), así que hay que borrarlos a mano antes de
// eliminar las filas; si no, quedarían huérfanos hasta la reconciliación periódica.
export const eliminarEmpresa = async (id: string): Promise<void> => {
  const empresa = await empresaRepo().findOneBy({ id });
  if (!empresa) throw new AppError(404, "Empresa no encontrada");

  // Todos los archivos de la empresa: los personales de sus usuarios y los de sus
  // carpetas compartidas comparten `propietario` (miembro de la empresa), así que
  // un único filtro por `empresaId` los cubre a ambos. `withDeleted` incluye los de
  // la papelera, que siguen teniendo su binario en MinIO.
  const archivos = await AppDataSource.getRepository(Archivo)
    .createQueryBuilder("a")
    .innerJoin("a.propietario", "u")
    .where("u.empresaId = :id", { id })
    .withDeleted()
    .select(["a.id", "a.claveMinio"])
    .getMany();

  const claves = archivos.map((a) => a.claveMinio);
  if (claves.length > 0) {
    // removeObjects borra en lote y es idempotente con claves inexistentes.
    await minioClient.removeObjects(env.MINIO_BUCKET, claves);
  }

  await empresaRepo().remove(empresa);
};
