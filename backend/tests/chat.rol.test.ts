import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario, tokenUsuario } from "./helpers";

// Chat consciente del ROL (Fase 3): las capacidades del rol gatean qué puede
// hacer el asistente. La gestión básica de archivos personales SIEMPRE está
// disponible; las facturas se gatean con la capacidad "facturas". El flujo es
// determinista (pre-flights + guard RBAC), no necesita Ollama.
describe("Chat por rol (Fase 3)", () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const chat = (token: string, texto: string) =>
    request(app)
      .post("/api/chat")
      .set(auth(token))
      .send({ mensajes: [{ rol: "usuario", contenido: texto }] });

  let adminToken: string;
  let conFacturasToken: string; // miembro con un rol que incluye "facturas"
  let sinFacturasToken: string; // miembro sin ningún rol (capacidades vacías)

  beforeAll(async () => {
    const admin = await crearUsuario(`cr_admin_${Date.now()}@test.com`, { rol: "admin" });
    adminToken = admin.token;

    const rolId = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminToken))
        .send({ nombre: "contabilidad", capacidades: ["facturas"] })
    ).body.id;

    const email = `cr_con_${Date.now()}@test.com`;
    await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({ nombre: "C", email, password: "password123", rol: "miembro", rolesIds: [rolId] });
    conFacturasToken = (
      await request(app).post("/api/auth/login").send({ email, password: "password123" })
    ).body.token;

    sinFacturasToken = await tokenUsuario(`cr_sin_${Date.now()}@test.com`);
  });

  it("miembro SIN la capacidad 'facturas' -> el chat responde que no está disponible", async () => {
    const res = await chat(sinFacturasToken, "lista mis facturas");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).toContain("no está disponible para tu rol");
    expect(res.body.tablaFacturas).toBeUndefined();
  });

  it("miembro CON la capacidad 'facturas' -> el chat sí lista las facturas", async () => {
    const res = await chat(conFacturasToken, "lista mis facturas de junio 2026");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).not.toContain("no está disponible para tu rol");
    expect(res.body.tablaFacturas).toBeDefined();
  });

  it("un miembro sin rol conserva la gestión básica de archivos personales", async () => {
    // Subir un archivo personal y listarlo por el chat NO requiere capacidad.
    await request(app)
      .post("/api/archivos/subir")
      .set(auth(sinFacturasToken))
      .attach("archivo", Buffer.from("hola mundo"), { filename: "hola.txt", contentType: "text/plain" });

    const res = await chat(sinFacturasToken, "qué archivos tengo");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).not.toContain("no está disponible para tu rol");
    expect(res.body.respuesta).toContain("hola.txt");
  });

  it("el admin tiene todas las capacidades: el chat le lista facturas", async () => {
    const res = await chat(adminToken, "lista mis facturas de junio 2026");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).not.toContain("no está disponible para tu rol");
    expect(res.body.tablaFacturas).toBeDefined();
  });
});
