import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

// Estado conversacional pendiente del chat, sacado de memoria a Postgres (#2):
// antes vivía en dos `Map` (pendientesAclaracion / pendientesValor) que se
// perdían al reiniciar la API a mitad de una aclaración. Cada usuario tiene como
// mucho UN pendiente a la vez (registrar una aclaración borra el valor pendiente
// y viceversa), por eso `usuarioId` es la PK y `tipo` discrimina cuál es.
//
// `payload` guarda el objeto original tal cual (tool, args, opciones/pregunta y
// `ts`), para que la lógica de los pre-flights del chat no cambie. La FK con
// ON DELETE CASCADE hacia usuarios se crea en la migración.
@Entity("chat_pendientes")
export class ChatPendiente {
  @PrimaryColumn({ type: "uuid" })
  usuarioId!: string;

  // "confirmacion" = operación masiva IRREVERSIBLE (p. ej. vaciar la papelera)
  // pendiente de un "sí" explícito antes de ejecutarse (#9).
  @Column({ type: "varchar" })
  tipo!: "aclaracion" | "valor" | "confirmacion";

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  // Marca de caducidad (TTL 5 min). Los pre-flights ya comprueban `payload.ts`,
  // pero esto permite además purgar filas viejas sin depender de leerlas.
  @Column({ type: "timestamptz" })
  expiraEn!: Date;

  @UpdateDateColumn()
  actualizadoEn!: Date;
}
