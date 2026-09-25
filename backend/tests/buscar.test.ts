import request from "supertest";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { app } from "../src/app";
import { AppDataSource } from "../src/config/database";
import { crearUsuario, UsuarioTest } from "./helpers";

// Buscador del explorador: por nombre y contenido, sin IA.
describe("Buscador de archivos", () => {
  let a: UsuarioTest;
  let b: UsuarioTest;
  const auth = (u: UsuarioTest) => ({ Authorization: `Bearer ${u.token}` });

  const subir = async (u: UsuarioTest, nombre: string, texto: string): Promise<void> => {
    const res = await request(app)
      .post("/api/archivos/subir")
      .set(auth(u))
      .attach("archivo", Buffer.from(nombre + texto), { filename: nombre, contentType: "text/plain" });
    expect(res.status).toBe(201);
    // En los tests no corre el worker: el texto extraído se fija a mano.
    await AppDataSource.query(`UPDATE "archivos" SET "textoExtraido" = $1 WHERE "id" = $2`, [
      texto,
      res.body.id,
    ]);
  };

  const buscar = async (u: UsuarioTest, q: string) =>
    (await request(app).get("/api/archivos/buscar").query({ q }).set(auth(u))).body as {
      nombre: string;
      fragmento: string;
    }[];

  beforeAll(async () => {
    a = await crearUsuario(`bus_a_${Date.now()}@test.com`);
    b = await crearUsuario(`bus_b_${Date.now()}@test.com`);
    await subir(a, "Presupuesto reforma.txt", "Cocina y baño. Garantía de dos años.");
    await subir(a, "notas.txt", "Llamar al fontanero el lunes.");
    await subir(b, "otro.txt", "Garantía del cliente B.");
  });

  it("encuentra por parte del nombre, sin mayúsculas", async () => {
    const r = await buscar(a, "presu");
    expect(r.map((x) => x.nombre)).toEqual(["Presupuesto reforma.txt"]);
  });

  it("encuentra por contenido sin tildes y devuelve el trozo", async () => {
    const r = await buscar(a, "garantia");
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe("Presupuesto reforma.txt");
    expect(r[0].fragmento).toContain("Garantía");
  });

  it("exige todas las palabras", async () => {
    expect(await buscar(a, "fontanero lunes")).toHaveLength(1);
    expect(await buscar(a, "fontanero martes")).toHaveLength(0);
  });

  it("no devuelve archivos de otros usuarios", async () => {
    const r = await buscar(a, "cliente");
    expect(r).toHaveLength(0);
  });

  it("los comodines se buscan literalmente", async () => {
    expect(await buscar(a, "%%")).toHaveLength(0);
  });
});
