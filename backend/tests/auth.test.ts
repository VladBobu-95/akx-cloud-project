import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect } from "@jest/globals";

const email = `auth_${Date.now()}@test.com`;

describe("Auth", () => {
  let token: string;

  it("registro -> 201 y no expone passwordHash", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({ email, password: "password123", nombre: "Auth Test" });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.usuario.passwordHash).toBeUndefined();
    token = res.body.token;
  });

  it("registro sin nombre -> 400 (nombre obligatorio)", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({ email: `sinnombre_${Date.now()}@test.com`, password: "password123" });
    expect(res.status).toBe(400);
  });

  it("registro con rol:admin NO escala privilegios (queda como user)", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({
        email: `admin_${Date.now()}@test.com`,
        password: "password123",
        nombre: "Intento Admin",
        rol: "admin",
      });
    expect(res.status).toBe(201);
    // El rol del input se ignora: el servidor siempre crea "user".
    expect(res.body.usuario.rol).toBe("user");
  });

  it("registro duplicado -> 409", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({ email, password: "password123", nombre: "Auth Test" });
    expect(res.status).toBe(409);
  });

  it("registro con password corta -> 400", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({ email: `x_${Date.now()}@test.com`, password: "123", nombre: "X" });
    expect(res.status).toBe(400);
  });

  it("login correcto -> 200 sin passwordHash", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.usuario.passwordHash).toBeUndefined();
  });

  it("login con password incorrecta -> 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "incorrecta" });
    expect(res.status).toBe(401);
  });

  it("perfil sin token -> 401", async () => {
    const res = await request(app).get("/api/auth/perfil");
    expect(res.status).toBe(401);
  });

  it("perfil con token -> 200", async () => {
    const res = await request(app)
      .get("/api/auth/perfil")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario.email).toBe(email);
  });
});
