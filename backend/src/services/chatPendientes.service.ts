import { AppDataSource } from "../config/database";
import { ChatPendiente } from "../entities/ChatPendiente";

// Acceso al estado conversacional pendiente del chat (tabla chat_pendientes).
// Reemplaza a los Map en memoria de chat.service.ts (#2): sobrevive a reinicios.
// Un usuario tiene como mucho un pendiente; guardar uno reemplaza el anterior
// (sea del tipo que sea), igual que la semántica original (registrar aclaración
// borraba el valor pendiente y viceversa).

export type TipoPendiente = "aclaracion" | "valor" | "confirmacion";

const repo = () => AppDataSource.getRepository(ChatPendiente);

// Guarda (o reemplaza) el pendiente del usuario. `payload` se guarda tal cual
// (incluye `ts` para que los pre-flights mantengan su comprobación de TTL).
export const guardarPendiente = async (
  usuarioId: string,
  tipo: TipoPendiente,
  payload: Record<string, unknown>,
  ttlMs: number,
): Promise<void> => {
  // save() hace upsert por la PK (usuarioId): si ya hay un pendiente de ese
  // usuario lo reemplaza, sea del tipo que sea (misma semántica que el Map).
  const entidad = repo().create({
    usuarioId,
    tipo,
    payload,
    expiraEn: new Date(Date.now() + ttlMs),
  });
  await repo().save(entidad);
};

// Lee y BORRA el pendiente del usuario si es del tipo pedido (operación "tomar").
// Devuelve el payload original (sin filtrar por caducidad: el llamador comprueba
// `payload.ts` como antes), o null si no hay pendiente de ese tipo. Si el
// pendiente es de OTRO tipo, no lo toca (devuelve null).
export const tomarPendiente = async <T>(
  usuarioId: string,
  tipo: TipoPendiente,
): Promise<T | null> => {
  const filas = (await repo()
    .createQueryBuilder()
    .delete()
    .from(ChatPendiente)
    .where(`"usuarioId" = :usuarioId AND "tipo" = :tipo`, { usuarioId, tipo })
    .returning("payload")
    .execute()).raw as { payload: Record<string, unknown> }[];
  return filas.length > 0 ? (filas[0].payload as T) : null;
};
