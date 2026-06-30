import request from "supertest";
import { app } from "../src/app";
import { AppDataSource } from "../src/config/database";
import { Tarea } from "../src/entities/Tarea";
import { env } from "../src/config/env";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

// Cap de backlog por usuario (#8): si un usuario ya tiene demasiadas tareas
// pendientes/en proceso en la cola durable, subir/escanear devuelve 429. (El
// rate-limit por tiempo se desactiva en test, como el de /auth; aquí probamos
// el límite de concurrencia, que sí está activo.)
describe("Límite de backlog por usuario (#8)", () => {
  let token: string;
  let userId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const subir = (contenido: string) =>
    request(app)
      .post("/api/archivos/subir")
      .set(auth())
      .attach("archivo", Buffer.from(contenido), { filename: "x.txt", contentType: "text/plain" });

  beforeAll(async () => {
    const u = await crearUsuario(`backlog_${Date.now()}@test.com`);
    token = u.token;
    userId = u.id;
  });

  it("una subida normal pasa cuando no hay backlog", async () => {
    const res = await subir("contenido backlog seed");
    expect(res.status).toBe(201);
  });

  it("con backlog >= umbral, subir -> 429", async () => {
    // Necesitamos un archivoId válido (FK de tareas). Reutilizamos el del seed.
    const seed = await subir("contenido backlog ancla");
    const archivoId = seed.body.id as string;

    // Sembramos tareas pendientes hasta el umbral configurado.
    const repo = AppDataSource.getRepository(Tarea);
    const filas = Array.from({ length: env.MAX_BACKLOG_USUARIO }, () => ({
      tipo: "indexar" as const,
      archivoId,
      usuarioId: userId,
      estado: "pendiente" as const,
    }));
    await repo.insert(filas);

    const res = await subir("contenido backlog que deberia rebotar");
    expect(res.status).toBe(429);
  });
});
