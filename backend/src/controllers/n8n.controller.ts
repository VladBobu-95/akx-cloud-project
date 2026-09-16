import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { chatear } from "../services/chat.service";

// Body que manda n8n (Telegram): missatge = texto; chat_id/user_id se devuelven
// iguales para que n8n sepa a qué chat de Telegram responder.
const schemaChatN8n = z
  .object({
    mensajes: z
      .array(z.object({ rol: z.enum(["usuario", "bot"]), contenido: z.string() }))
      .min(1)
      .optional(),
    mensaje: z.string().optional(),
    missatge: z.string().optional(),
    idOpcion: z.string().optional(),
    chat_id: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
  })
  .refine((d) => !!(d.mensajes?.length || d.mensaje?.trim() || d.missatge?.trim()), {
    message: "Falta el mensaje (missatge)",
  });

export const ctrlChatN8n = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const datos = schemaChatN8n.parse(req.body);
    const texto = (datos.mensaje ?? datos.missatge ?? "").trim();
    const mensajes = datos.mensajes ?? [{ rol: "usuario" as const, contenido: texto }];
    const resultado = await chatear(req.usuario!.id, mensajes, datos.idOpcion);
    res.json({
      ...resultado,
      ...(datos.chat_id !== undefined ? { chat_id: datos.chat_id } : {}),
      ...(datos.user_id !== undefined ? { user_id: datos.user_id } : {}),
    });
  } catch (error) {
    next(error);
  }
};
