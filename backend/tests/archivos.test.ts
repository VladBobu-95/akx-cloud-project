import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";

// Registra un usuario y devuelve su token
const registrar = async (email: string): Promise<string> => {
  const res = await request(app)
    .post("/api/auth/registro")
    .send({ email, password: "password123", nombre: "Archivos Test" });
  return res.body.token as string;
};

describe("Archivos", () => {
  let token: string; // dueño
  let token2: string; // otro usuario (para probar 403)
  let fileId: string;

  const auth = (t: string = token) => ({ Authorization: `Bearer ${t}` });

  const subir = (t: string = token, nombre = "a.txt") =>
    request(app)
      .post("/api/archivos/subir")
      .set(auth(t))
      .attach("archivo", Buffer.from("contenido de prueba"), {
        filename: nombre,
        contentType: "text/plain",
      });

  beforeAll(async () => {
    token = await registrar(`arch_${Date.now()}@test.com`);
    token2 = await registrar(`arch2_${Date.now()}@test.com`);
  });

  it("subir -> 201", async () => {
    const res = await subir().field("carpeta", "/docs");
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    fileId = res.body.id;
  });

  it("subir tipo no permitido -> 400", async () => {
    const res = await request(app)
      .post("/api/archivos/subir")
      .set(auth())
      .attach("archivo", Buffer.from("x"), {
        filename: "a.bin",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(400);
  });

  it("subir sin archivo -> 400", async () => {
    const res = await request(app).post("/api/archivos/subir").set(auth());
    expect(res.status).toBe(400);
  });

  it("listar -> 200 con cabeceras de paginacion", async () => {
    const res = await request(app).get("/api/archivos").set(auth());
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBeDefined();
    expect(res.headers["x-total-pages"]).toBeDefined();
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("obtener -> 200 y NO expone passwordHash ni propietario", async () => {
    const res = await request(app).get(`/api/archivos/${fileId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.propietario).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("obtener archivo ajeno -> 403", async () => {
    const res = await request(app)
      .get(`/api/archivos/${fileId}`)
      .set(auth(token2));
    expect(res.status).toBe(403);
  });

  it("obtener inexistente -> 404", async () => {
    const res = await request(app)
      .get("/api/archivos/11111111-1111-4111-8111-111111111111")
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("uuid invalido -> 400", async () => {
    const res = await request(app).get("/api/archivos/no-es-uuid").set(auth());
    expect(res.status).toBe(400);
  });

  it("sin token -> 401", async () => {
    const res = await request(app).get("/api/archivos");
    expect(res.status).toBe(401);
  });

  it("descargar -> 200 con el contenido (streaming)", async () => {
    const res = await request(app)
      .get(`/api/archivos/${fileId}/descargar`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("actualizar -> 200 y NO expone passwordHash", async () => {
    const res = await request(app)
      .patch(`/api/archivos/${fileId}`)
      .set(auth())
      .send({ nombre: "renombrado.txt" });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe("renombrado.txt");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("eliminar (soft) -> 204, aparece en papelera y se restaura", async () => {
    const del = await request(app)
      .delete(`/api/archivos/${fileId}`)
      .set(auth());
    expect(del.status).toBe(204);

    const pap = await request(app).get("/api/archivos/papelera").set(auth());
    expect(pap.body.some((a: { id: string }) => a.id === fileId)).toBe(true);

    const rest = await request(app)
      .patch(`/api/archivos/${fileId}/restaurar`)
      .set(auth());
    expect(rest.status).toBe(200);
  });

  it("borrar permanente -> 204 y desaparece por completo", async () => {
    // primero a la papelera
    await request(app).delete(`/api/archivos/${fileId}`).set(auth());

    const res = await request(app)
      .delete(`/api/archivos/${fileId}/permanente`)
      .set(auth());
    expect(res.status).toBe(204);

    const pap = await request(app).get("/api/archivos/papelera").set(auth());
    expect(pap.body.some((a: { id: string }) => a.id === fileId)).toBe(false);

    const get = await request(app).get(`/api/archivos/${fileId}`).set(auth());
    expect(get.status).toBe(404);
  });

  it("vaciar papelera -> borra todo lo eliminado del usuario", async () => {
    // subir 2 y mandarlos a la papelera
    for (let i = 0; i < 2; i++) {
      const up = await subir(token, `z${i}.txt`);
      await request(app).delete(`/api/archivos/${up.body.id}`).set(auth());
    }

    const res = await request(app).delete("/api/archivos/papelera").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.borrados).toBeGreaterThanOrEqual(2);

    const pap = await request(app).get("/api/archivos/papelera").set(auth());
    expect(pap.body.length).toBe(0);
  });
});
