import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  Unique,
} from "typeorm";
import { Empresa } from "./Empresa";
import { Rol } from "./Rol";

// Carpeta COMPARTIDA: un espacio de almacenamiento de la empresa accesible por
// los roles indicados. A diferencia de las carpetas personales (gobernadas por
// `propietario`), aquí el acceso lo deciden empresa + roles. Los archivos dentro
// llevan `carpetaCompartidaId` y su propia ruta `carpeta` para las subcarpetas.
// El almacenamiento es ÚNICO: lo que sube un usuario lo ven todos los del rol.
@Entity("carpetas_compartidas")
@Unique(["empresaId", "nombre"])
export class CarpetaCompartida {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  nombre!: string;

  @Column({ type: "uuid" })
  empresaId!: string;

  @ManyToOne(() => Empresa, { onDelete: "CASCADE" })
  @JoinColumn({ name: "empresaId" })
  empresa!: Empresa;

  // Roles que pueden acceder. Un miembro accede si tiene alguno de estos roles
  // (el admin de la empresa accede a todas las suyas).
  @ManyToMany(() => Rol)
  @JoinTable({
    name: "carpeta_compartida_roles",
    joinColumn: { name: "carpetaCompartidaId", referencedColumnName: "id" },
    inverseJoinColumn: { name: "rolId", referencedColumnName: "id" },
  })
  roles!: Rol[];

  @CreateDateColumn()
  creadoEn!: Date;
}
