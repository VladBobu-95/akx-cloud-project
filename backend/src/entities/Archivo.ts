import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  Index,
  DeleteDateColumn,
} from "typeorm";
import { Usuario } from "./Usuario";

// IMPORTANTE: aqui solo guardamos METADATA.
// El archivo binario real vive en MinIO, referenciado por "claveMinio".
@Entity("archivos")
export class Archivo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  nombre!: string;

  @Index()
  @Column({ default: "/" })
  carpeta!: string; // ruta virtual tipo "/facturas/2026"

  @Column()
  mimeType!: string;

  @Column({ type: "bigint" })
  tamanoBytes!: string;

  @Column({ unique: true })
  claveMinio!: string; // clave del objeto en el bucket

  @Column({ nullable: true })
  hashSha256?: string; // para detectar duplicados

  // Texto extraido del documento (PDF, docx...).
  @Column({ type: "text", nullable: true })
  textoExtraido?: string;

  // Estado del escaneo de factura: null = no aplica (no es PDF/imagen o nunca se
  // intentó). "pendiente" = en cola para escanear. "escaneando" = en proceso.
  // "escaneada" = factura guardada en BD. "no_factura" = se comprobó y no parecía
  // una factura real. "error" = fallo técnico (ej. Ollama no responde).
  @Column({ type: "varchar", nullable: true })
  estadoEscaneo?: "pendiente" | "escaneando" | "escaneada" | "no_factura" | "error" | null;

  // DeleteDateColumn: TypeORM rellena esta columna con la fecha actual al hacer softRemove().
  // Si tiene valor → archivo en la papelera. Si es null → archivo activo.
  // Las queries normales (find, findOne) ignoran automáticamente los registros con esta columna rellena.
  @DeleteDateColumn({ nullable: true })
  eliminadoEn?: Date;

  @ManyToOne(() => Usuario, (usuario) => usuario.archivos, {
    onDelete: "CASCADE",
  })
  propietario!: Usuario;

  @CreateDateColumn()
  subidoEn!: Date;
}
