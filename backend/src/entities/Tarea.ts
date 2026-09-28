import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

// Cola de trabajos DURABLE (sobrevive a reinicios de la API), en Postgres.
// Sustituye a las colas en memoria que alimentaban la extracción de texto y el
// auto-escaneo de facturas al subir: aquellas perdían la tarea (y los bytes,
// que vivían en el `req.file.buffer` de un closure) si el proceso se reiniciaba
// a mitad. Aquí el worker (tareas.service.ts) RELEE los bytes desde MinIO, así
// que una tarea es reanudable e idempotente. Da además reintentos con backoff,
// límite de concurrencia hacia Ollama (backpressure) y visibilidad (es una
// tabla: se puede inspeccionar en Adminer).
//
// No usamos relaciones @ManyToOne para mantener las queries del worker simples;
// las FK con ON DELETE CASCADE hacia archivos/usuarios se crean en la migración.
@Entity("tareas")
// Índice que usa el worker para reclamar la siguiente tarea disponible.
@Index(["estado", "disponibleEn", "prioridad"])
export class Tarea {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // "indexar"     → extrae texto (OCR de imágenes / pdf-parse / docx).
  // "autoescanear" → extrae los datos de factura (IA) del texto ya indexado.
  @Column({ type: "varchar" })
  tipo!: "indexar" | "autoescanear";

  @Column({ type: "uuid" })
  archivoId!: string;

  @Column({ type: "uuid" })
  usuarioId!: string;

  // pendiente → en_proceso → ok | error
  @Column({ type: "varchar", default: "pendiente" })
  estado!: "pendiente" | "en_proceso" | "ok" | "error";

  // Menor = antes (el worker ordena por prioridad y luego por antigüedad). Hoy
  // todas van a 0 (FIFO): el agrupado por fases que evitaba alternar modelos en
  // la GPU sobra desde que un solo modelo lo hace todo.
  @Column({ type: "int", default: 0 })
  prioridad!: number;

  @Column({ type: "int", default: 0 })
  intentos!: number;

  @Column({ type: "int", default: 3 })
  maxIntentos!: number;

  // El worker solo reclama tareas con disponibleEn <= now(). En un reintento se
  // pospone (backoff) para no martillear un Ollama que está caído.
  @Column({ type: "timestamptz", default: () => "now()" })
  disponibleEn!: Date;

  // Pista opcional para el escaneo manual de factura (clic derecho → Escanear).
  @Column({ type: "text", nullable: true })
  pista?: string | null;

  // Último error técnico (para diagnóstico cuando la tarea agota reintentos).
  @Column({ type: "text", nullable: true })
  error?: string | null;

  @CreateDateColumn()
  creadoEn!: Date;

  @UpdateDateColumn()
  actualizadoEn!: Date;
}
