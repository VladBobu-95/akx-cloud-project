import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

const email = `auth_${Date.now()}@test.com`;

describe("Auth", () => {
  let token: string;

  beforeAll(async () => {
    // Ya no hay registro público: el usuario se crea directamente (la contraseña
    // del helper es "password123").
    const u = await crearUsuario(email);
    token = u.token;
  });

  it("registro público ya no existe -> 404", async () => {
    const res = await request(app)
      .post("/api/auth/registro")
      .send({ email: `x_${Date.now()}@test.com`, password: "password123", nombre: "X" });
    expect(res.status).toBe(404);
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
