import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

// Chat consciente del ROL. La capacidad MAESTRA "chat" abre el chatbot entero
// (sin ella, POST /api/chat responde 403 antes de llamar a la IA). Lo que el
// chat puede LEER dentro (facturas, contenido de documentos) lo filtran las
// vistas de la BD: ver chat.sql.test.ts. El chat no modifica nada; lo que
// modifica archivos es la API, gateada por "gestion_archivos".
describe("Chat por rol", () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let adminToken: string;
  let soloChatToken: string; // miembro con rol ["chat"] (sin gestión)
  let sinChatToken: string; // miembro sin ningún rol (capacidades vacías)

  beforeAll(async () => {
    const admin = await crearUsuario(`cr_admin_${Date.now()}@test.com`, { rol: "admin" });
    adminToken = admin.token;

    const rolId = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminToken))
        .send({ nombre: `cr_chat_${Date.now()}`, capacidades: ["chat"] })
    ).body.id;
    const email = `cr_chat_${Date.now()}@test.com`;
    await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({ nombre: "M", email, password: "password123", rol: "miembro", rolesIds: [rolId] });
    soloChatToken = (
      await request(app).post("/api/auth/login").send({ email, password: "password123" })
    ).body.token;

    // Miembro sin ningún rol: hay que pedir la lista vacía a propósito, porque
    // por defecto el helper da todas las capacidades.
    sinChatToken = (await crearUsuario(`cr_sin_${Date.now()}@test.com`, { capacidades: [] })).token;
  });

  it("miembro sin la capacidad maestra 'chat' -> el chatbot responde 403", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set(auth(sinChatToken))
      .send({ mensajes: [{ rol: "usuario", contenido: "qué archivos tengo" }] });
    expect(res.status).toBe(403);
  });

  it("miembro SIN 'gestion_archivos' -> la API rechaza subir y borrar con 403", async () => {
    const subida = await request(app)
      .post("/api/archivos/subir")
      .set(auth(soloChatToken))
      .attach("archivo", Buffer.from("no debe entrar"), { filename: "no.txt", contentType: "text/plain" });
    expect(subida.status).toBe(403);

    const carpeta = await request(app)
      .post("/api/archivos/carpetas")
      .set(auth(soloChatToken))
      .send({ ruta: "/prohibida" });
    expect(carpeta.status).toBe(403);

    const papelera = await request(app).delete("/api/archivos/papelera").set(auth(soloChatToken));
    expect(papelera.status).toBe(403);
  });
});
