import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Usuario } from "./Usuario";
import { Empresa } from "./Empresa";

// API keys de n8n (y similares). El secreto en claro solo se muestra al crear;
// aquí se guarda el hash SHA-256. Ligada al usuario que la genera: las subidas
// y el chat de n8n actúan como esa cuenta. Admin y miembro pueden tener las suyas.
@Entity("claves_api")
@Index(["usuarioId", "revocadaEn"])
export class ClaveApi {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ default: "n8n" })
  nombre!: string;

  // Recorte visible, p. ej. "akx_live_ab12cd". Nunca el secreto.
  @Column()
  prefijo!: string;

  @Column({ unique: true })
  hash!: string;

  @Column({ type: "uuid" })
  usuarioId!: string;

  @ManyToOne(() => Usuario, { onDelete: "CASCADE" })
  @JoinColumn({ name: "usuarioId" })
  usuario!: Usuario;

  @Column({ type: "uuid", nullable: true })
  empresaId?: string | null;

  @ManyToOne(() => Empresa, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "empresaId" })
  empresa?: Empresa | null;

  @Column({ type: "timestamp", nullable: true })
  ultimoUso?: Date | null;

  @CreateDateColumn()
  creadoEn!: Date;

  @Column({ type: "timestamp", nullable: true })
  revocadaEn?: Date | null;
};
