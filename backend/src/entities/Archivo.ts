import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
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

  // Estado del indexado RAG (extracción de texto + embeddings), separado de
  // `estadoEscaneo` (que es específico de facturas). Lo gestiona el worker
  // durable (tareas.service.ts): "indexando" mientras se procesa, "indexado"
  // cuando hay texto/embeddings, "error" si la extracción falló tras agotar
  // reintentos. null = aún sin indexar / no aplica. Permite mostrar en el
  // explorador "procesando…" o "no se pudo leer el contenido" en vez de que un
  // archivo recién subido simplemente no aparezca en las búsquedas sin motivo.
  @Column({ type: "varchar", nullable: true })
  estadoIndexado?: "pendiente" | "indexando" | "indexado" | "error" | null;

  @Column({ type: "timestamptz", nullable: true })
  indexadoEn?: Date | null;

  // DeleteDateColumn: TypeORM rellena esta columna con la fecha actual al hacer softRemove().
  // Si tiene valor → archivo en la papelera. Si es null → archivo activo.
  // Las queries normales (find, findOne) ignoran automáticamente los registros con esta columna rellena.
  @DeleteDateColumn({ nullable: true })
  eliminadoEn?: Date;

  @ManyToOne(() => Usuario, (usuario) => usuario.archivos, {
    onDelete: "CASCADE",
  })
  propietario!: Usuario;

  // Si tiene valor, el archivo vive en una CARPETA COMPARTIDA (acceso por
  // empresa+roles, no por propietario). Si es null, es un archivo personal
  // gobernado por `propietario`. `propietario` se mantiene como autor/auditoría
  // de quién lo subió. Ver compartido.service.ts.
  @Column({ type: "uuid", nullable: true })
  carpetaCompartidaId?: string | null;

  @CreateDateColumn()
  subidoEn!: Date;

  // Última modificación del registro: se actualiza sola al guardar (renombrar,
  // mover, copiar, reindexar…). Es la "última actualización" que muestra el
  // explorador de carpetas compartidas.
  @UpdateDateColumn()
  actualizadoEn!: Date;
}
