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

  // Texto extraido del documento (PDF, docx, OCR de imagen...).
  @Column({ type: "text", nullable: true })
  textoExtraido?: string;

  // Descripción escrita a mano por el usuario (modal "¿Qué es esta imagen?" al
  // subir una foto). Se guarda separada de `textoExtraido` para poder combinar
  // las dos (ver `combinarContenido` en archivos.service.ts) sin que una
  // sobrescriba a la otra según cuál termine antes (el OCR es en segundo plano
  // y puede tardar más que rellenar el modal).
  @Column({ type: "text", nullable: true })
  descripcionManual?: string;

  // Estado del pipeline en segundo plano al subir (indexado RAG + escaneo de
  // factura). "pendiente"/"escaneando" se ponen para CUALQUIER archivo (para
  // que la columna "Estado" del explorador muestre la animación mientras se
  // procesa, sea o no candidato a factura). Al terminar: "escaneada" = factura
  // guardada en BD, "no_factura" = se comprobó y no parecía una factura real,
  // "error" = fallo técnico (ej. Ollama no responde), null = no era candidato
  // a factura (no hay nada más que mostrar, queda en blanco).
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
