import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { tokenUsuario } from "./helpers";

// Confirmación de operaciones masivas irreversibles en el chat (#9). Solo
// vaciar la papelera (borrado DEFINITIVO) la requiere; el resto sigue instantáneo.
// El flujo es determinista (pre-flights + BD), no necesita Ollama.
describe("Confirmación vaciar papelera (#9)", () => {
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const subirYborrar = async (nombre: string) => {
    const up = await request(app)
      .post("/api/archivos/subir")
      .set(auth())
      .attach("archivo", Buffer.from(`contenido ${nombre} ${Date.now()}`), {
        filename: nombre,
        contentType: "text/plain",
      });
    await request(app).delete(`/api/archivos/${up.body.id}`).set(auth());
  };

  const chat = (texto: string) =>
    request(app)
      .post("/api/chat")
      .set(auth())
      .send({ mensajes: [{ rol: "usuario", contenido: texto }] });

  const papelera = async (): Promise<number> => {
    const res = await request(app).get("/api/archivos/papelera").set(auth());
    return res.body.length as number;
  };

  beforeAll(async () => {
    token = await tokenUsuario(`conf_${Date.now()}@test.com`);
  });

  it("'vaciar papelera' pide confirmación y NO borra todavía", async () => {
    await subirYborrar("a.txt");
    expect(await papelera()).toBe(1);

    const res = await chat("vacía la papelera");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).toContain("no se puede deshacer");
    // No se ha tocado la papelera.
    expect(await papelera()).toBe(1);
  });

  it("'sí' confirma y vacía la papelera", async () => {
    const res = await chat("sí");
    expect(res.body.respuesta.toLowerCase()).toContain("vaciado");
    expect(await papelera()).toBe(0);
  });

  it("'no' cancela y NO borra", async () => {
    await subirYborrar("b.txt");
    expect(await papelera()).toBe(1);

    await chat("borra toda la papelera");
    const res = await chat("no");
    expect(res.body.respuesta.toLowerCase()).toContain("cancelado");
    expect(await papelera()).toBe(1);
  });

  it("otra orden tras pedir confirmación la cancela y se atiende", async () => {
    await chat("vacíame la papelera"); // pide confirmar
    const res = await chat("qué hay en la papelera"); // otra orden
    // Atiende la consulta y NO vacía.
    expect(res.body.respuesta.toLowerCase()).toContain("papelera");
    expect(await papelera()).toBe(1);
  });
});
