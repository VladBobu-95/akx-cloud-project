import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  Unique,
} from "typeorm";
import { Usuario } from "./Usuario";

// Carpeta "explícita" del usuario (creada a mano o por el chatbot). Las carpetas
// que solo existen porque contienen archivos se derivan de la ruta del archivo;
// esta tabla guarda además las carpetas (incluidas las vacías) para que persistan
// y se vean igual desde la web y desde el asistente.
@Entity("carpetas")
@Unique(["propietario", "ruta"])
export class Carpeta {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  ruta!: string; // ruta canónica tipo "/facturas/2026"

  @ManyToOne(() => Usuario, { onDelete: "CASCADE" })
  propietario!: Usuario;

  @CreateDateColumn()
  creadaEn!: Date;
}
