import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  Unique,
} from "typeorm";
import { Empresa } from "./Empresa";
import { Usuario } from "./Usuario";

// Rol FUNCIONAL configurable por el admin de cada empresa (contabilidad,
// mantenimiento, ventas...). Distinto del nivel de cuenta (Usuario.rol). Un
// usuario puede tener 0..N roles (N:N con `usuario_roles`). Cada rol otorga un
// conjunto de `capacidades` del vocabulario fijo (config/capacidades.ts).
@Entity("roles")
@Unique(["empresaId", "nombre"])
export class Rol {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  nombre!: string;

  // Capacidades que otorga este rol (subconjunto de CAPACIDADES).
  @Column({ type: "text", array: true, default: () => "'{}'" })
  capacidades!: string[];

  @Column({ type: "uuid" })
  empresaId!: string;

  @ManyToOne(() => Empresa, { onDelete: "CASCADE" })
  @JoinColumn({ name: "empresaId" })
  empresa!: Empresa;

  @ManyToMany(() => Usuario, (usuario) => usuario.roles)
  usuarios!: Usuario[];

  @CreateDateColumn()
  creadoEn!: Date;
}
