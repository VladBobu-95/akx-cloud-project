import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { tokenUsuario } from "./helpers";

// Deduplicación por hash (#4): subir el mismo contenido dos veces no debe crear
// una segunda copia ni reprocesar; debe devolver el archivo existente con
// `duplicado: true`. El hash es del CONTENIDO, así que un nombre distinto con
// los mismos bytes también es duplicado.
describe("Dedup por hash", () => {
  let token: string;
  let token2: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const subir = (t: string, contenido: string, filename = "dup.txt") =>
    request(app)
      .post("/api/archivos/subir")
      .set(auth(t))
      .attach("archivo", Buffer.from(contenido), { filename, contentType: "text/plain" });

  const registrar = (email: string): Promise<string> => tokenUsuario(email);

  beforeAll(async () => {
    token = await registrar(`dedup_${Date.now()}@test.com`);
    token2 = await registrar(`dedup2_${Date.now()}@test.com`);
  });

  it("primera subida -> 201, no duplicado", async () => {
    const res = await subir(token, "contenido dedup unico AAA");
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.duplicado).toBeFalsy();
    expect(res.body.hashSha256).toBeDefined();
  });

  it("misma contenido otra vez -> 200, duplicado:true, MISMO id", async () => {
    const primera = await subir(token, "contenido dedup repetido BBB");
    const segunda = await subir(token, "contenido dedup repetido BBB", "otro-nombre.txt");
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicado).toBe(true);
    expect(segunda.body.id).toBe(primera.body.id);
  });

  it("contenido distinto -> 201, no duplicado", async () => {
    const res = await subir(token, "contenido dedup DIFERENTE CCC");
    expect(res.status).toBe(201);
    expect(res.body.duplicado).toBeFalsy();
  });

  it("el dedup es por usuario: otro usuario sube el mismo contenido -> 201", async () => {
    await subir(token, "contenido compartido entre usuarios DDD");
    const otro = await subir(token2, "contenido compartido entre usuarios DDD");
    expect(otro.status).toBe(201);
    expect(otro.body.duplicado).toBeFalsy();
  });

  it("un archivo en papelera no bloquea re-subir el mismo (dedup solo entre vivos)", async () => {
    const up = await subir(token, "contenido que se borra EEE");
    await request(app).delete(`/api/archivos/${up.body.id}`).set(auth(token));
    const reSubida = await subir(token, "contenido que se borra EEE");
    expect(reSubida.status).toBe(201);
    expect(reSubida.body.duplicado).toBeFalsy();
  });
});
