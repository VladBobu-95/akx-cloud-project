import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { chatear } from "../services/chat.service";

const schemaChat = z.object({
  mensajes: z
    .array(
      z.object({
        rol: z.enum(["usuario", "bot"]),
        contenido: z.string(),
      }),
    )
    .min(1),
  // Solo presente cuando el usuario eligió una opción pulsando un botón de la
  // tabla de aclaración (en vez de escribirla a mano).
  idOpcion: z.string().optional(),
});

// POST /api/chat
export const ctrlChat = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { mensajes, idOpcion } = schemaChat.parse(req.body);
    const resultado = await chatear(req.usuario!.id, mensajes, idOpcion);
    res.json(resultado);
  } catch (error) {
    next(error);
  }
};
