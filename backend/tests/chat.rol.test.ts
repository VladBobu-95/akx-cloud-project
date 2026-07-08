import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

// Chat consciente del ROL (Fase 3): las capacidades del rol gatean qué puede
// hacer el asistente. La capacidad MAESTRA "chat" abre el chatbot entero (sin
// ella, POST /api/chat responde 403); una vez dentro, la gestión básica de
// archivos personales está disponible y las facturas se gatean aparte con la
// capacidad "facturas". El flujo es determinista (pre-flights + guard RBAC),
// no necesita Ollama.
describe("Chat por rol (Fase 3)", () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const chat = (token: string, texto: string) =>
    request(app)
      .post("/api/chat")
      .set(auth(token))
      .send({ mensajes: [{ rol: "usuario", contenido: texto }] });

  let adminToken: string;
  let conFacturasToken: string; // miembro con rol ["chat", "facturas"]
  let soloChatToken: string; // miembro con rol ["chat"] (sin "facturas")
  let sinChatToken: string; // miembro sin ningún rol (capacidades vacías)

  // Crea un miembro con el rol de capacidades dado y devuelve su token de login.
  const crearMiembroConRol = async (
    prefijo: string,
    capacidades: string[],
  ): Promise<string> => {
    const rolId = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminToken))
        .send({ nombre: `${prefijo}_${Date.now()}`, capacidades })
    ).body.id;
    const email = `${prefijo}_${Date.now()}@test.com`;
    await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({ nombre: "M", email, password: "password123", rol: "miembro", rolesIds: [rolId] });
    return (await request(app).post("/api/auth/login").send({ email, password: "password123" }))
      .body.token;
  };

  beforeAll(async () => {
    const admin = await crearUsuario(`cr_admin_${Date.now()}@test.com`, { rol: "admin" });
    adminToken = admin.token;

    conFacturasToken = await crearMiembroConRol("cr_con", ["chat", "facturas"]);
    soloChatToken = await crearMiembroConRol("cr_chat", ["chat"]);
    sinChatToken = (await crearUsuario(`cr_sin_${Date.now()}@test.com`)).token; // miembro sin rol
  });

  it("miembro sin la capacidad maestra 'chat' -> el chatbot responde 403", async () => {
    const res = await chat(sinChatToken, "qué archivos tengo");
    expect(res.status).toBe(403);
  });

  it("miembro con 'chat' pero SIN 'facturas' -> el chat responde que no está disponible", async () => {
    const res = await chat(soloChatToken, "lista mis facturas");
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

  it("miembro con 'chat' conserva la gestión básica de archivos personales", async () => {
    // Subir un archivo personal y listarlo por el chat no requiere "facturas".
    await request(app)
      .post("/api/archivos/subir")
      .set(auth(soloChatToken))
      .attach("archivo", Buffer.from("hola mundo"), { filename: "hola.txt", contentType: "text/plain" });

    const res = await chat(soloChatToken, "qué archivos tengo");
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
