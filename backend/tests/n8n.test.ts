import request from "supertest";
import { app } from "../src/app";
import { env } from "../src/config/env";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

const CLAVE = "n8n-test-key-0001";

describe("n8n light (API key)", () => {
  let email: string;
  let token: string;
  const prevKey = env.N8N_API_KEY;
  const prevEmail = env.N8N_USER_EMAIL;

  const subir = (opts?: { key?: string | null; nombre?: string; tipo?: string; body?: Buffer }) => {
    const req = request(app).post("/api/n8n/facturas");
    if (opts?.key !== null) req.set("X-Api-Key", opts?.key ?? CLAVE);
    return req.attach("archivo", opts?.body ?? Buffer.from("factura n8n de prueba"), {
      filename: opts?.nombre ?? "factura.txt",
      contentType: opts?.tipo ?? "text/plain",
    });
  };

  beforeAll(async () => {
    const u = await crearUsuario(`n8n_${Date.now()}@test.com`, { rol: "admin" });
    email = u.email;
    token = u.token;
    env.N8N_API_KEY = CLAVE;
    env.N8N_USER_EMAIL = email;
  });

  afterAll(() => {
    env.N8N_API_KEY = prevKey;
    env.N8N_USER_EMAIL = prevEmail;
  });

  it("sin header -> 401", async () => {
    const res = await subir({ key: null });
    expect(res.status).toBe(401);
  });

  it("key incorrecta -> 401", async () => {
    const res = await subir({ key: "clave-que-no-es-la-buena" });
    expect(res.status).toBe(401);
  });

  it("sin key de .env (y sin clave de BD) -> 401", async () => {
    env.N8N_API_KEY = undefined;
    const res = await subir();
    env.N8N_API_KEY = CLAVE;
    expect(res.status).toBe(401);
  });

  it("subir con key válida -> 201 y el archivo es del usuario mapeado", async () => {
    const res = await subir();
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();

    const listado = await request(app)
      .get("/api/archivos")
      .set({ Authorization: `Bearer ${token}` });
    expect(listado.status).toBe(200);
    expect(listado.body.some((a: { id: string }) => a.id === res.body.id)).toBe(true);
  });

  it("PDF con magic bytes -> 201", async () => {
    const res = await subir({
      nombre: "factura.pdf",
      tipo: "application/pdf",
      body: Buffer.from("%PDF-1.4 n8n"),
    });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe("application/pdf");
  });

  it("sin archivo -> 400", async () => {
    const res = await request(app).post("/api/n8n/facturas").set("X-Api-Key", CLAVE);
    expect(res.status).toBe(400);
  });

  it("tipo no permitido -> 400", async () => {
    const res = await subir({
      nombre: "a.bin",
      tipo: "application/octet-stream",
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
  });

  it("chat sin key -> 401", async () => {
    const res = await request(app).post("/api/n8n/chat").send({ mensaje: "hola" });
    expect(res.status).toBe(401);
  });

  it("chat con mensajes vacíos -> 400", async () => {
    const res = await request(app)
      .post("/api/n8n/chat")
      .set("X-Api-Key", CLAVE)
      .send({ mensajes: [] });
    expect(res.status).toBe(400);
  });

  it("chat sin missatge (solo ids de Telegram) -> 400", async () => {
    const res = await request(app)
      .post("/api/n8n/chat")
      .set("X-Api-Key", CLAVE)
      .send({ chat_id: "123", user_id: "456" });
    expect(res.status).toBe(400);
  });

  it("empresa suspendida -> 403", async () => {
    const u = await crearUsuario(`n8n_susp_${Date.now()}@test.com`, {
      rol: "admin",
      estadoEmpresa: "suspendida",
    });
    env.N8N_USER_EMAIL = u.email;
    const res = await subir({ body: Buffer.from("otra factura n8n") });
    env.N8N_USER_EMAIL = email;
    expect(res.status).toBe(403);
  });
});
