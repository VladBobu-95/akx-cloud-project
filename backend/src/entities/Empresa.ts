import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from "typeorm";
import { Usuario } from "./Usuario";

// Tenant del SaaS: cada empresa cliente. Todo lo de una empresa (usuarios, roles,
// carpetas compartidas y, vía sus usuarios, archivos/facturas) cuelga de aquí. El
// superadmin de la plataforma da de alta empresas y crea el admin de cada una; el
// superadmin NO pertenece a ninguna empresa (Usuario.empresaId = null).
@Entity("empresas")
export class Empresa {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  nombre!: string;

  // "activa" = opera con normalidad. "suspendida" = sus usuarios no pueden entrar
  // (bloqueo en login y en cada petición), sin borrar nada. Lo controla el superadmin.
  @Column({ default: "activa" })
  estado!: "activa" | "suspendida";

  @CreateDateColumn()
  creadoEn!: Date;

  @OneToMany(() => Usuario, (usuario) => usuario.empresa)
  usuarios!: Usuario[];
}
