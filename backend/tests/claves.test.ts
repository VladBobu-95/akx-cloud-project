import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

describe("claves API (n8n por usuario)", () => {
  let tokenAdmin: string;
  let tokenMiembro: string;
  let tokenOtro: string;

  beforeAll(async () => {
    const admin = await crearUsuario(`claves_admin_${Date.now()}@test.com`, { rol: "admin" });
    tokenAdmin = admin.token;
    const miembro = await crearUsuario(`claves_miem_${Date.now()}@test.com`, {
      rol: "miembro",
      empresaId: admin.empresaId ?? undefined,
    });
    tokenMiembro = miembro.token;
    tokenOtro = (await crearUsuario(`claves_otro_${Date.now()}@test.com`, { rol: "admin" })).token;
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("miembro puede crear una clave y se muestra el secreto una vez", async () => {
    const res = await request(app)
      .post("/api/claves")
      .set(auth(tokenMiembro))
      .send({ nombre: "telegram" });
    expect(res.status).toBe(201);
    expect(res.body.clave).toMatch(/^ateka_live_/);
    expect(res.body.prefijo).toBe(res.body.clave.slice(0, 16));
    expect(res.body.nombre).toBe("telegram");
    expect(res.body.hash).toBeUndefined();
  });

  it("el listado no incluye el secreto", async () => {
    const res = await request(app).get("/api/claves").set(auth(tokenMiembro));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].clave).toBeUndefined();
    expect(res.body[0].hash).toBeUndefined();
    expect(res.body[0].prefijo).toMatch(/^ateka_live_/);
  });

  it("la clave de BD autentica POST /api/n8n/facturas", async () => {
    const creada = await request(app).post("/api/claves").set(auth(tokenAdmin)).send({});
    expect(creada.status).toBe(201);
    const res = await request(app)
      .post("/api/n8n/facturas")
      .set("X-Api-Key", creada.body.clave)
      .attach("archivo", Buffer.from("factura clave bd"), {
        filename: "f.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("revocada -> 401", async () => {
    const creada = await request(app).post("/api/claves").set(auth(tokenAdmin)).send({ nombre: "tmp" });
    const id = creada.body.id as string;
    const del = await request(app).delete(`/api/claves/${id}`).set(auth(tokenAdmin));
    expect(del.status).toBe(204);
    const res = await request(app)
      .post("/api/n8n/facturas")
      .set("X-Api-Key", creada.body.clave)
      .attach("archivo", Buffer.from("ya revocada"), {
        filename: "f.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(401);
  });

  it("no puedes revocar la clave de otro", async () => {
    const creada = await request(app).post("/api/claves").set(auth(tokenAdmin)).send({ nombre: "mia" });
    const res = await request(app)
      .delete(`/api/claves/${creada.body.id}`)
      .set(auth(tokenOtro));
    expect(res.status).toBe(404);
  });
});
