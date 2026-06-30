import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { crearUsuario, tokenUsuario } from "./helpers";

// Equipo (Fase 2): roles configurables con capacidades, alta/edición de miembros,
// ver archivos de un miembro, control de acceso (soloAdmin) y aislamiento por empresa.
describe("Equipo (Fase 2)", () => {
  let adminToken: string;
  let empresaId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const admin = await crearUsuario(`eq_admin_${Date.now()}@test.com`, { rol: "admin" });
    adminToken = admin.token;
    empresaId = admin.empresaId!;
  });

  it("un miembro normal no accede al equipo -> 403", async () => {
    const m = await tokenUsuario(`eq_nm_${Date.now()}@test.com`);
    const res = await request(app).get("/api/equipo/usuarios").set(auth(m));
    expect(res.status).toBe(403);
  });

  it("admin crea un rol con capacidades", async () => {
    const res = await request(app)
      .post("/api/equipo/roles")
      .set(auth(adminToken))
      .send({ nombre: "contabilidad", capacidades: ["facturas", "busqueda"] });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe("contabilidad");
    expect(res.body.capacidades.sort()).toEqual(["busqueda", "facturas"]);
  });

  it("rechaza una capacidad inválida -> 400", async () => {
    const res = await request(app)
      .post("/api/equipo/roles")
      .set(auth(adminToken))
      .send({ nombre: "raro", capacidades: ["inventada"] });
    expect(res.status).toBe(400);
  });

  it("rol con nombre duplicado en la empresa -> 409", async () => {
    const res = await request(app)
      .post("/api/equipo/roles")
      .set(auth(adminToken))
      .send({ nombre: "contabilidad", capacidades: [] });
    expect(res.status).toBe(409);
  });

  it("admin crea un miembro con un rol funcional", async () => {
    const roles = (await request(app).get("/api/equipo/roles").set(auth(adminToken))).body;
    const rolId = roles[0].id;
    const res = await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({
        nombre: "Empleado",
        email: `eq_emp_${Date.now()}@test.com`,
        password: "password123",
        rol: "miembro",
        rolesIds: [rolId],
      });
    expect(res.status).toBe(201);
    expect(res.body.roles.length).toBe(1);
    expect(res.body.passwordHash).toBeUndefined();
  });

  it("no acepta rolesIds de otra empresa -> 400", async () => {
    const adminB = await crearUsuario(`eq_adminB_${Date.now()}@test.com`, { rol: "admin" });
    const rolB = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminB.token))
        .send({ nombre: "ventas", capacidades: [] })
    ).body;

    const res = await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({
        nombre: "X",
        email: `eq_x_${Date.now()}@test.com`,
        password: "password123",
        rolesIds: [rolB.id],
      });
    expect(res.status).toBe(400);
  });

  it("editar miembro: cambia su rol de cuenta y sus roles", async () => {
    const crear = await request(app)
      .post("/api/equipo/usuarios")
      .set(auth(adminToken))
      .send({ nombre: "Editable", email: `eq_ed_${Date.now()}@test.com`, password: "password123" });
    const id = crear.body.id;

    const res = await request(app)
      .patch(`/api/equipo/usuarios/${id}`)
      .set(auth(adminToken))
      .send({ rol: "admin", rolesIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe("admin");
  });

  it("ver los archivos de un miembro", async () => {
    const miembro = await crearUsuario(`eq_files_${Date.now()}@test.com`, { empresaId });
    await request(app)
      .post("/api/archivos/subir")
      .set(auth(miembro.token))
      .attach("archivo", Buffer.from("hola"), { filename: "h.txt", contentType: "text/plain" });

    const res = await request(app)
      .get(`/api/equipo/usuarios/${miembro.id}/archivos`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.archivos.length).toBe(1);
  });

  it("aislamiento: un admin no ve ni edita miembros de otra empresa", async () => {
    const adminB = await crearUsuario(`eq_isoB_${Date.now()}@test.com`, { rol: "admin" });
    const miembroA = await crearUsuario(`eq_isoA_${Date.now()}@test.com`, { empresaId });

    // adminB lista su equipo: no aparece el miembro de la empresa A.
    const listaB = (await request(app).get("/api/equipo/usuarios").set(auth(adminB.token))).body;
    expect(listaB.find((m: { id: string }) => m.id === miembroA.id)).toBeUndefined();

    // adminB intenta editar un miembro de A -> 404 (fuera de su empresa).
    const res = await request(app)
      .patch(`/api/equipo/usuarios/${miembroA.id}`)
      .set(auth(adminB.token))
      .send({ nombre: "hack" });
    expect(res.status).toBe(404);
  });

  it("el admin no puede eliminarse a sí mismo -> 400", async () => {
    const me = (await request(app).get("/api/equipo/usuarios").set(auth(adminToken))).body.find(
      (m: { rol: string; email: string }) => m.email.startsWith("eq_admin_"),
    );
    const res = await request(app).delete(`/api/equipo/usuarios/${me.id}`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it("eliminar un rol -> 204", async () => {
    const rol = (
      await request(app)
        .post("/api/equipo/roles")
        .set(auth(adminToken))
        .send({ nombre: `tmp_${Date.now()}`, capacidades: [] })
    ).body;
    const res = await request(app).delete(`/api/equipo/roles/${rol.id}`).set(auth(adminToken));
    expect(res.status).toBe(204);
  });
});
