import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario, tokenUsuario } from "./helpers";
import { minioClient } from "../src/config/minio";
import { env } from "../src/config/env";

// Panel de plataforma (superadmin) + multi-tenant: alta de empresas con su admin,
// control de acceso, suspensión y aislamiento entre empresas.
describe("Plataforma / multi-tenant (Fase 1)", () => {
  let superToken: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    superToken = (await crearUsuario(`super_${Date.now()}@test.com`, { rol: "superadmin" })).token;
  });

  it("superadmin crea empresa + su primer admin -> 201", async () => {
    const res = await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({
        nombre: "Acme S.L.",
        admin: { nombre: "Jefa Acme", email: `admin_acme_${Date.now()}@test.com`, password: "password123" },
      });
    expect(res.status).toBe(201);
    expect(res.body.empresa.id).toBeDefined();
    expect(res.body.admin.rol).toBe("admin");
    expect(res.body.admin.empresaId).toBe(res.body.empresa.id);
    expect(res.body.admin.passwordHash).toBeUndefined();
  });

  it("el admin recién creado puede hacer login", async () => {
    const email = `admin_login_${Date.now()}@test.com`;
    await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({ nombre: "Beta", admin: { nombre: "B", email, password: "password123" } });

    const res = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.usuario.rol).toBe("admin");
  });

  it("un miembro normal NO puede entrar al panel de plataforma -> 403", async () => {
    const miembro = await tokenUsuario(`miembro_${Date.now()}@test.com`);
    const res = await request(app).get("/api/plataforma/empresas").set(auth(miembro));
    expect(res.status).toBe(403);
  });

  it("sin token -> 401 en el panel", async () => {
    const res = await request(app).get("/api/plataforma/empresas");
    expect(res.status).toBe(401);
  });

  it("email de admin duplicado -> 409", async () => {
    const email = `dup_${Date.now()}@test.com`;
    await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({ nombre: "Uno", admin: { nombre: "U", email, password: "password123" } });
    const res = await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({ nombre: "Dos", admin: { nombre: "D", email, password: "password123" } });
    expect(res.status).toBe(409);
  });

  it("empresa suspendida: su admin no puede hacer login -> 403", async () => {
    const email = `susp_${Date.now()}@test.com`;
    const creada = await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({ nombre: "Suspendible", admin: { nombre: "S", email, password: "password123" } });

    // Login OK mientras está activa.
    expect((await request(app).post("/api/auth/login").send({ email, password: "password123" })).status).toBe(200);

    // Suspender y reintentar login.
    await request(app)
      .patch(`/api/plataforma/empresas/${creada.body.empresa.id}`)
      .set(auth(superToken))
      .send({ estado: "suspendida" });

    const res = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    expect(res.status).toBe(403);
  });

  it("empresa suspendida bloquea peticiones con token ya emitido -> 403", async () => {
    // Token emitido ANTES de suspender (la empresa se crea activa).
    const { token, empresaId } = await crearUsuario(`activo_${Date.now()}@test.com`);
    expect((await request(app).get("/api/archivos").set(auth(token))).status).toBe(200);

    await request(app)
      .patch(`/api/plataforma/empresas/${empresaId}`)
      .set(auth(superToken))
      .send({ estado: "suspendida" });

    const res = await request(app).get("/api/archivos").set(auth(token));
    expect(res.status).toBe(403);
  });

  it("borrar empresa limpia los binarios en MinIO (no deja huérfanos)", async () => {
    const email = `del_${Date.now()}@test.com`;
    const creada = await request(app)
      .post("/api/plataforma/empresas")
      .set(auth(superToken))
      .send({ nombre: "Borrable", admin: { nombre: "X", email, password: "password123" } });
    const empresaId = creada.body.empresa.id;

    const login = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    const adminToken = login.body.token as string;

    const subida = await request(app)
      .post("/api/archivos/subir")
      .set(auth(adminToken))
      .attach("archivo", Buffer.from(`bin ${Date.now()}`), { filename: "b.txt", contentType: "text/plain" });
    const clave = subida.body.claveMinio as string;
    expect(clave).toBeTruthy();
    // El objeto existe en MinIO antes de borrar la empresa.
    await expect(minioClient.statObject(env.MINIO_BUCKET, clave)).resolves.toBeDefined();

    const del = await request(app).delete(`/api/plataforma/empresas/${empresaId}`).set(auth(superToken));
    expect(del.status).toBe(204);

    // Tras borrar la empresa, el binario ya no está (no queda huérfano en MinIO).
    await expect(minioClient.statObject(env.MINIO_BUCKET, clave)).rejects.toBeDefined();
  });

  it("aislamiento: un usuario no ve archivos de otra empresa", async () => {
    const a = await crearUsuario(`empA_${Date.now()}@test.com`);
    const b = await crearUsuario(`empB_${Date.now()}@test.com`);

    await request(app)
      .post("/api/archivos/subir")
      .set(auth(a.token))
      .attach("archivo", Buffer.from("solo de A"), { filename: "a.txt", contentType: "text/plain" });

    const listaB = await request(app).get("/api/archivos").set(auth(b.token));
    expect(listaB.status).toBe(200);
    expect(listaB.body.length).toBe(0);
  });
});
