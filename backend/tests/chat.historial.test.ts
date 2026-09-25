import { describe, it, expect } from "@jest/globals";
import { sinPreguntasHuerfanas, MensajeChat } from "../src/services/chat.service";

// Historial que se manda al modelo: las preguntas que se quedaron sin respuesta
// (canceladas al mandar otra mientras la IA pensaba) se descartan, para que el
// modelo no conteste dos preguntas a la vez.
describe("Historial del chat", () => {
  const u = (contenido: string): MensajeChat => ({ rol: "usuario", contenido });
  const b = (contenido: string): MensajeChat => ({ rol: "bot", contenido });

  it("quita las preguntas seguidas de otra pregunta", () => {
    const r = sinPreguntasHuerfanas([u("hola"), b("¡Hola!"), u("text2"), u("resumen texto.webp")]);
    expect(r.map((m) => m.contenido)).toEqual(["hola", "¡Hola!", "resumen texto.webp"]);
  });

  it("conserva la conversación normal y siempre la última pregunta", () => {
    const conversacion = [u("¿cuánto facturé en abril?"), b("1.200 €"), u("¿y en mayo?")];
    expect(sinPreguntasHuerfanas(conversacion)).toEqual(conversacion);
    expect(sinPreguntasHuerfanas([u("a"), u("b"), u("c")])).toEqual([u("c")]);
  });
});
