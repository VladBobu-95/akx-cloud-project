import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
} from "typeorm";
import { Archivo } from "./Archivo";
import { Empresa } from "./Empresa";
import { Rol } from "./Rol";

@Entity("usuarios")
export class Usuario {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ nullable: true })
  nombre?: string; // nombre de usuario visible

  @Column({ type: "text", nullable: true })
  avatar?: string | null; // imagen de perfil (data URL base64); null = sin imagen

  @Column()
  passwordHash!: string;

  // Nivel de CUENTA (no confundir con los roles funcionales configurables, que son
  // una relación N:N aparte): "superadmin" = dueño de la plataforma (sin empresa,
  // gestiona empresas), "admin" = administra SU empresa (equipo, roles, compartido),
  // "miembro" = empleado normal.
  @Column({ default: "miembro" })
  rol!: "superadmin" | "admin" | "miembro";

  // Empresa (tenant) a la que pertenece. Null SOLO para el superadmin de la
  // plataforma. Columna FK explícita para poder leer empresaId sin cargar la
  // relación (lo usa la generación del JWT y el aislamiento por empresa).
  @Column({ type: "uuid", nullable: true })
  empresaId?: string | null;

  @ManyToOne(() => Empresa, (empresa) => empresa.usuarios, {
    onDelete: "CASCADE",
    nullable: true,
  })
  @JoinColumn({ name: "empresaId" })
  empresa?: Empresa | null;

  // Roles funcionales (N:N). 0..N por usuario; un "miembro" sin roles es un
  // usuario normal. No aplica al superadmin (sin empresa, sin roles).
  @ManyToMany(() => Rol, (rol) => rol.usuarios)
  @JoinTable({
    name: "usuario_roles",
    joinColumn: { name: "usuarioId", referencedColumnName: "id" },
    inverseJoinColumn: { name: "rolId", referencedColumnName: "id" },
  })
  roles?: Rol[];

  @CreateDateColumn()
  creadoEn!: Date;

  @OneToMany(() => Archivo, (archivo) => archivo.propietario)
  archivos!: Archivo[];
}
