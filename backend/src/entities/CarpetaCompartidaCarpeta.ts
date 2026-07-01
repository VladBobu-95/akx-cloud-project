import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { CarpetaCompartida } from "./CarpetaCompartida";

// Subcarpeta EXPLÍCITA dentro de una carpeta compartida. Equivalente a `Carpeta`
// para el espacio personal: las subcarpetas que solo existen porque contienen
// archivos se derivan de la ruta del archivo, pero esta tabla guarda además las
// carpetas (incluidas las vacías) para que persistan igual que en "Mis archivos".
// El acceso lo gobierna la carpeta compartida (empresa+roles), no un propietario.
@Entity("carpeta_compartida_carpetas")
@Unique(["carpetaCompartidaId", "ruta"])
export class CarpetaCompartidaCarpeta {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  ruta!: string; // ruta canónica dentro de la carpeta compartida, tipo "/2026/enero"

  @Column({ type: "uuid" })
  carpetaCompartidaId!: string;

  @ManyToOne(() => CarpetaCompartida, { onDelete: "CASCADE" })
  @JoinColumn({ name: "carpetaCompartidaId" })
  carpetaCompartida!: CarpetaCompartida;

  @CreateDateColumn()
  creadaEn!: Date;
}
