import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  Index,
  JoinColumn,
} from "typeorm";
import { CarpetaCompartida } from "./CarpetaCompartida";
import { Usuario } from "./Usuario";

// Acciones que se registran en el historial de una carpeta compartida.
export type AccionCompartida =
  | "subir"
  | "descargar"
  | "renombrar"
  | "mover"
  | "copiar"
  | "eliminar"
  | "copia_personal"
  | "crear_carpeta"
  | "borrar_carpeta"
  | "mover_carpeta";

// Registro de actividad (auditoría) de una carpeta compartida: quién hizo qué y
// cuándo. Solo metadatos (filas pequeñas), NO copias de archivos — el binario
// sigue viviendo en MinIO. La retención periódica purga lo más antiguo.
@Entity("eventos_compartido")
@Index(["carpetaCompartidaId", "creadoEn"])
export class EventoCompartido {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  carpetaCompartidaId!: string;

  @ManyToOne(() => CarpetaCompartida, { onDelete: "CASCADE" })
  @JoinColumn({ name: "carpetaCompartidaId" })
  carpetaCompartida!: CarpetaCompartida;

  // Quién hizo la acción. SET NULL si se borra el usuario (el evento se conserva);
  // `usuarioNombre` guarda el nombre del momento para poder mostrarlo igualmente.
  @Column({ type: "uuid", nullable: true })
  usuarioId!: string | null;

  @ManyToOne(() => Usuario, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "usuarioId" })
  usuario?: Usuario | null;

  @Column()
  usuarioNombre!: string;

  @Column({ type: "varchar" })
  accion!: AccionCompartida;

  // Nombre del archivo o carpeta afectado (snapshot, sobrevive a su borrado).
  @Column({ type: "varchar", nullable: true })
  objeto?: string | null;

  // Ruta (dentro de la carpeta compartida) donde ocurrió la acción.
  @Column({ type: "varchar", nullable: true })
  ruta?: string | null;

  // Detalle libre: "X → Y" en renombrados/movimientos, origen en copias, etc.
  @Column({ type: "varchar", nullable: true })
  detalle?: string | null;

  @CreateDateColumn()
  creadoEn!: Date;
}
