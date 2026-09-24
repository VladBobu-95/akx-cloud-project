import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

// Chat consciente del ROL (Fase 3): las capacidades del rol gatean qué puede
// hacer el asistente. La capacidad MAESTRA "chat" abre el chatbot entero (sin
// ella, POST /api/chat responde 403); dentro, cada área se gatea aparte:
// "facturas" para los datos de facturas y "gestion_archivos" para todo lo que
// MODIFIQUE archivos (subir, mover, renombrar, borrar, papelera), tanto por la
// API como por el chat. El flujo es determinista (pre-flights + guard RBAC),
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
  let soloChatToken: string; // miembro con rol ["chat"] (sin "facturas" ni gestión)
  let conGestionToken: string; // miembro con rol ["chat", "gestion_archivos"]
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
    conGestionToken = await crearMiembroConRol("cr_gest", ["chat", "gestion_archivos"]);
    // Miembro sin ningún rol: hay que pedir la lista vacía a propósito, porque
    // por defecto el helper da todas las capacidades.
    sinChatToken = (await crearUsuario(`cr_sin_${Date.now()}@test.com`, { capacidades: [] })).token;
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

  it("miembro con 'gestion_archivos' sube y lista sus archivos por el chat", async () => {
    const subida = await request(app)
      .post("/api/archivos/subir")
      .set(auth(conGestionToken))
      .attach("archivo", Buffer.from("hola mundo"), { filename: "hola.txt", contentType: "text/plain" });
    expect(subida.status).toBe(201);

    const res = await chat(conGestionToken, "qué archivos tengo");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).not.toContain("no está disponible para tu rol");
    expect(res.body.respuesta).toContain("hola.txt");
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

  it("miembro SIN 'gestion_archivos' -> el chat tampoco borra (pre-flight vetado)", async () => {
    // Pre-flight de borrado masivo: sin la capacidad avisa en vez de ejecutar.
    const res = await chat(soloChatToken, "vacía la papelera");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).toContain("no permite gestionar archivos");

    // Y sigue pudiendo LEER: listar sus archivos no requiere la capacidad.
    const lectura = await chat(soloChatToken, "qué archivos tengo");
    expect(lectura.status).toBe(200);
    expect(lectura.body.respuesta.toLowerCase()).not.toContain("no permite gestionar archivos");
  });

  it("el admin tiene todas las capacidades: el chat le lista facturas", async () => {
    const res = await chat(adminToken, "lista mis facturas de junio 2026");
    expect(res.status).toBe(200);
    expect(res.body.respuesta.toLowerCase()).not.toContain("no está disponible para tu rol");
    expect(res.body.tablaFacturas).toBeDefined();
  });
});
