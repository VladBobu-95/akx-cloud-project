import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario } from "./helpers";

// Carpetas compartidas por rol (Fase 3): el admin las crea y asigna roles; los
// miembros con esos roles ven/usan el almacenamiento ÚNICO (lo que sube uno lo
// ven todos los del rol). Acceso por empresa+roles, aislado entre empresas. Los
// archivos compartidos NO van a la papelera (borrado directo que afecta a todos).
describe("Carpetas compartidas (Fase 3)", () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let adminToken: string;
  let empresaId: string;
  let rolContaId: string;
  let carpetaId: string;
  let miembroConToken: string; // miembro CON el rol de contabilidad
  let miembroSinToken: string; // miembro SIN ningún rol

  // Crea un miembro vía el endpoint de equipo (con roles) y devuelve su token
  // haciendo login (la contraseña la fija el propio test).
  const crearMiembroConLogin = async (
    email: string,
    rolesIds: string[],
  ): Promise<string> => {
    await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({ nombre: "M", email, password: "password123", rol: "miembro", rolesIds });
    const login = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    return login.body.token as string;
  };

  beforeAll(async () => {
    const admin = await crearUsuario(`cs_admin_${Date.now()}@test.com`, { rol: "admin" });
    adminToken = admin.token;
    empresaId = admin.empresaId!;

    rolContaId = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminToken))
        .send({ nombre: "contabilidad", capacidades: ["facturas"] })
    ).body.id;

    miembroConToken = await crearMiembroConLogin(`cs_con_${Date.now()}@test.com`, [rolContaId]);
    miembroSinToken = await crearMiembroConLogin(`cs_sin_${Date.now()}@test.com`, []);
  });

  it("un miembro no puede crear carpetas compartidas (solo admin) -> 403", async () => {
    const res = await request(app)
      .post("/api/compartido/admin")
      .set(auth(miembroConToken))
      .send({ nombre: "X", rolesIds: [] });
    expect(res.status).toBe(403);
  });

  it("admin crea una carpeta compartida y le asigna el rol", async () => {
    const res = await request(app)
      .post("/api/compartido/admin")
      .set(auth(adminToken))
      .send({ nombre: "Contabilidad", rolesIds: [rolContaId] });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe("Contabilidad");
    carpetaId = res.body.id;
  });

  it("nombre duplicado en la empresa -> 409", async () => {
    const res = await request(app)
      .post("/api/compartido/admin")
      .set(auth(adminToken))
      .send({ nombre: "Contabilidad", rolesIds: [] });
    expect(res.status).toBe(409);
  });

  it("el miembro CON el rol ve la carpeta compartida", async () => {
    const res = await request(app).get("/api/compartido").set(auth(miembroConToken));
    expect(res.status).toBe(200);
    expect(res.body.find((c: { id: string }) => c.id === carpetaId)).toBeTruthy();
  });

  it("el miembro SIN el rol NO ve la carpeta compartida", async () => {
    const res = await request(app).get("/api/compartido").set(auth(miembroSinToken));
    expect(res.status).toBe(200);
    expect(res.body.find((c: { id: string }) => c.id === carpetaId)).toBeUndefined();
  });

  let archivoId: string;

  it("el miembro CON acceso sube un archivo a la carpeta compartida", async () => {
    const res = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(miembroConToken))
      .attach("archivo", Buffer.from(`compartido ${Date.now()}`), {
        filename: "nota.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);
    expect(res.body.carpetaCompartidaId).toBe(carpetaId);
    archivoId = res.body.id;
  });

  it("otro miembro con el mismo rol ve el archivo (almacenamiento único)", async () => {
    const otro = await crearMiembroConLogin(`cs_con2_${Date.now()}@test.com`, [rolContaId]);
    const res = await request(app).get(`/api/compartido/${carpetaId}/archivos`).set(auth(otro));
    expect(res.status).toBe(200);
    expect(res.body.archivos.find((a: { id: string }) => a.id === archivoId)).toBeTruthy();
  });

  it("el miembro SIN el rol NO puede listar ni subir a la carpeta -> 403", async () => {
    const listar = await request(app)
      .get(`/api/compartido/${carpetaId}/archivos`)
      .set(auth(miembroSinToken));
    expect(listar.status).toBe(403);

    const subir = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(miembroSinToken))
      .attach("archivo", Buffer.from("nope"), { filename: "n.txt", contentType: "text/plain" });
    expect(subir.status).toBe(403);
  });

  it("el miembro con acceso descarga el archivo compartido", async () => {
    const res = await request(app)
      .get(`/api/compartido/archivo/${archivoId}/descargar`)
      .set(auth(miembroConToken));
    expect(res.status).toBe(200);
    expect(res.text).toContain("compartido");
  });

  it("el miembro SIN acceso NO puede descargar el archivo compartido -> 403", async () => {
    const res = await request(app)
      .get(`/api/compartido/archivo/${archivoId}/descargar`)
      .set(auth(miembroSinToken));
    expect(res.status).toBe(403);
  });

  it("subir el mismo contenido no lo duplica (dedup por hash)", async () => {
    const contenido = "contenido-fijo-para-dedup";
    const primero = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(miembroConToken))
      .attach("archivo", Buffer.from(contenido), { filename: "dup.txt", contentType: "text/plain" });
    const segundo = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(miembroConToken))
      .attach("archivo", Buffer.from(contenido), { filename: "dup.txt", contentType: "text/plain" });
    expect(segundo.status).toBe(200);
    expect(segundo.body.duplicado).toBe(true);
    expect(segundo.body.id).toBe(primero.body.id);
  });

  it("el miembro con acceso borra el archivo compartido (afecta a todos) -> 204", async () => {
    const res = await request(app)
      .delete(`/api/compartido/archivo/${archivoId}`)
      .set(auth(miembroConToken));
    expect(res.status).toBe(204);

    const listar = await request(app).get(`/api/compartido/${carpetaId}/archivos`).set(auth(miembroConToken));
    expect(listar.body.archivos.find((a: { id: string }) => a.id === archivoId)).toBeUndefined();
  });

  it("aislamiento: un admin de otra empresa no ve la carpeta compartida", async () => {
    const adminB = await crearUsuario(`cs_adminB_${Date.now()}@test.com`, { rol: "admin" });
    const res = await request(app).get("/api/compartido/admin").set(auth(adminB.token));
    expect(res.status).toBe(200);
    expect(res.body.find((c: { id: string }) => c.id === carpetaId)).toBeUndefined();
  });

  it("no acepta rolesIds de otra empresa al crear -> 400", async () => {
    const adminB = await crearUsuario(`cs_isoB_${Date.now()}@test.com`, { rol: "admin" });
    const rolB = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminB.token))
        .send({ nombre: "ventas", capacidades: [] })
    ).body;
    const res = await request(app)
      .post("/api/compartido/admin")
      .set(auth(adminToken))
      .send({ nombre: "OtraCarpeta", rolesIds: [rolB.id] });
    expect(res.status).toBe(400);
  });
});

// Explorador completo dentro de una carpeta compartida (paridad con "Mis
// archivos"): subcarpetas persistidas, mover/renombrar/copiar y listado global.
describe("Carpetas compartidas — explorador completo", () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let adminToken: string;
  let carpetaId: string;

  beforeAll(async () => {
    adminToken = (await crearUsuario(`ce_admin_${Date.now()}@test.com`, { rol: "admin" })).token;
    carpetaId = (
      await request(app)
        .post("/api/compartido/admin")
        .set(auth(adminToken))
        .send({ nombre: `Espacio ${Date.now()}`, rolesIds: [] })
    ).body.id;
  });

  it("crea una subcarpeta y la lista", async () => {
    const crear = await request(app)
      .post(`/api/compartido/${carpetaId}/carpetas`)
      .set(auth(adminToken))
      .send({ ruta: "/2026" });
    expect(crear.status).toBe(201);

    const lista = await request(app).get(`/api/compartido/${carpetaId}/carpetas`).set(auth(adminToken));
    expect(lista.body.find((c: { ruta: string }) => c.ruta === "/2026")).toBeTruthy();
  });

  let archivoId: string;

  it("sube un archivo a una subcarpeta y /todos lo trae con su ruta", async () => {
    const subida = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(adminToken))
      .field("carpeta", "/2026")
      .attach("archivo", Buffer.from(`x ${Date.now()}`), { filename: "f.txt", contentType: "text/plain" });
    expect(subida.status).toBe(201);
    archivoId = subida.body.id;

    const todos = await request(app).get(`/api/compartido/${carpetaId}/todos`).set(auth(adminToken));
    const a = todos.body.find((x: { id: string; carpeta: string }) => x.id === archivoId);
    expect(a?.carpeta).toBe("/2026");
  });

  it("renombra/mueve un archivo dentro de la carpeta compartida", async () => {
    const res = await request(app)
      .patch(`/api/compartido/archivo/${archivoId}`)
      .set(auth(adminToken))
      .send({ nombre: "renombrado.txt", carpeta: "/2027" });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe("renombrado.txt");
    expect(res.body.carpeta).toBe("/2027");
  });

  it("copia un archivo (nuevo id + nombre '(copia)')", async () => {
    const res = await request(app)
      .post(`/api/compartido/archivo/${archivoId}/copiar`)
      .set(auth(adminToken))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(archivoId);
    expect(res.body.nombre).toContain("(copia)");
    expect(res.body.carpetaCompartidaId).toBe(carpetaId);
  });

  it("mueve una subcarpeta con su contenido", async () => {
    await request(app)
      .post(`/api/compartido/${carpetaId}/carpetas`)
      .set(auth(adminToken))
      .send({ ruta: "/a" });
    const sub = await request(app)
      .post(`/api/compartido/${carpetaId}/subir`)
      .set(auth(adminToken))
      .field("carpeta", "/a")
      .attach("archivo", Buffer.from(`y ${Date.now()}`), { filename: "g.txt", contentType: "text/plain" });
    const gid = sub.body.id;

    const mover = await request(app)
      .patch(`/api/compartido/${carpetaId}/carpetas`)
      .set(auth(adminToken))
      .send({ origen: "/a", destino: "/b" });
    expect(mover.status).toBe(200);

    const todos = await request(app).get(`/api/compartido/${carpetaId}/todos`).set(auth(adminToken));
    expect(todos.body.find((x: { id: string; carpeta: string }) => x.id === gid)?.carpeta).toBe("/b");

    const carpetas = await request(app).get(`/api/compartido/${carpetaId}/carpetas`).set(auth(adminToken));
    expect(carpetas.body.find((c: { ruta: string }) => c.ruta === "/b")).toBeTruthy();
    expect(carpetas.body.find((c: { ruta: string }) => c.ruta === "/a")).toBeFalsy();
  });

  it("borra la metadata de una subcarpeta", async () => {
    const res = await request(app)
      .delete(`/api/compartido/${carpetaId}/carpetas`)
      .query({ ruta: "/2027" })
      .set(auth(adminToken));
    expect(res.status).toBe(204);

    const carpetas = await request(app).get(`/api/compartido/${carpetaId}/carpetas`).set(auth(adminToken));
    expect(carpetas.body.find((c: { ruta: string }) => c.ruta === "/2027")).toBeFalsy();
  });

  it("un usuario sin acceso -> 403 en los nuevos endpoints", async () => {
    const otro = await crearUsuario(`ce_sin_${Date.now()}@test.com`, { rol: "miembro" });
    expect(
      (await request(app).get(`/api/compartido/${carpetaId}/todos`).set(auth(otro.token))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/compartido/${carpetaId}/carpetas`)
          .set(auth(otro.token))
          .send({ ruta: "/z" })
      ).status,
    ).toBe(403);
  });
});
