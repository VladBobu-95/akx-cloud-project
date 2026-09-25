import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { app } from "../src/app";
import { AppDataSource } from "../src/config/database";
import { prepararRolChat, cerrarPoolChat } from "../src/config/chatDb";
import { ChatSql1779000000000 } from "../src/migrations/1779000000000-ChatSql";
import { abrirAcceso, cerrarAcceso, ejecutarSql } from "../src/services/chat.service";
import { crearUsuario, UsuarioTest } from "./helpers";

// Frontera de seguridad del chat por SQL: el modelo escribe consultas que el
// backend ejecuta, así que un usuario puede intentar (a través del modelo) leer
// datos ajenos o modificar algo. Aquí se ejecuta SQL "hostil" directamente con
// el rol ateka_chat, sin pasar por Ollama.
describe("Chat por SQL: frontera de la BD", () => {
  let a: UsuarioTest;
  let b: UsuarioTest;
  const todo = { puedeFacturas: true, puedeContenido: true };

  const subir = async (u: UsuarioTest, nombre: string, texto: string): Promise<string> => {
    const res = await request(app)
      .post("/api/archivos/subir")
      .set({ Authorization: `Bearer ${u.token}` })
      .attach("archivo", Buffer.from(texto), { filename: nombre, contentType: "text/plain" });
    expect(res.status).toBe(201);
    // En los tests no corre el worker: el texto se fija a mano.
    await AppDataSource.query(`UPDATE "archivos" SET "textoExtraido" = $1 WHERE "id" = $2`, [
      texto,
      res.body.id,
    ]);
    return res.body.id;
  };

  const consultar = async (
    u: UsuarioTest,
    sql: string,
    permisos = todo,
  ): Promise<{ columnas: string[]; filas: unknown[][] }> => {
    const token = await abrirAcceso(u.id, permisos);
    try {
      return await ejecutarSql(token, sql);
    } finally {
      await cerrarAcceso(token);
    }
  };

  beforeAll(async () => {
    // Los tests montan el esquema con synchronize, que no ejecuta migraciones:
    // las vistas y el rol del chat se crean aquí.
    const [{ existe }] = await AppDataSource.query(
      `SELECT to_regclass('chat.archivos') IS NOT NULL AS existe`,
    );
    if (!existe) {
      const qr = AppDataSource.createQueryRunner();
      await new ChatSql1779000000000().up(qr);
      await qr.release();
    }
    await prepararRolChat();

    a = await crearUsuario(`sql_a_${Date.now()}@test.com`);
    b = await crearUsuario(`sql_b_${Date.now()}@test.com`);
    await subir(a, "presupuesto-a.txt", "presupuesto de la obra de A");
    await subir(b, "secreto-b.txt", "contraseña del banco de B");
  });

  afterAll(async () => {
    await cerrarPoolChat();
  });

  it("cada usuario solo ve sus archivos", async () => {
    const r = await consultar(a, "SELECT nombre FROM chat.archivos");
    const nombres = r.filas.map((f) => f[0]);
    expect(nombres).toContain("presupuesto-a.txt");
    expect(nombres).not.toContain("secreto-b.txt");
  });

  it("filtrar por contenido no deja ver archivos ajenos", async () => {
    const r = await consultar(a, "SELECT nombre FROM chat.archivos WHERE contenido ILIKE '%banco%'");
    expect(r.filas).toHaveLength(0);
  });

  it("sin la capacidad 'busqueda' el contenido llega vacío", async () => {
    const r = await consultar(a, "SELECT contenido FROM chat.archivos", {
      puedeFacturas: true,
      puedeContenido: false,
    });
    expect(r.filas.length).toBeGreaterThan(0);
    expect(r.filas.every((f) => f[0] === null)).toBe(true);
  });

  it("con un token ya cerrado las vistas no devuelven nada", async () => {
    const token = await abrirAcceso(a.id, todo);
    await cerrarAcceso(token);
    const r = await ejecutarSql(token, "SELECT nombre FROM chat.archivos");
    expect(r.filas).toHaveLength(0);
  });

  it("no puede leer las tablas reales", async () => {
    await expect(consultar(a, `SELECT email, "passwordHash" FROM public.usuarios`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(consultar(a, `SELECT * FROM public.chat_accesos`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("no puede encadenar sentencias", async () => {
    await expect(
      consultar(a, "SELECT 1) AS x; DELETE FROM public.archivos; SELECT (1"),
    ).rejects.toThrow();
    const [{ n }] = await AppDataSource.query(`SELECT count(*)::int AS n FROM "archivos"`);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("no puede modificar nada", async () => {
    await expect(
      consultar(a, "WITH d AS (DELETE FROM chat.archivos RETURNING 1) SELECT * FROM d"),
    ).rejects.toThrow();
    await expect(consultar(a, "INSERT INTO chat.archivos (nombre) VALUES ('x')")).rejects.toThrow();
  });

  it("no puede cambiar de rol", async () => {
    const [{ usuario }] = await AppDataSource.query(`SELECT current_user AS usuario`);
    await expect(
      consultar(a, `SELECT set_config('role', '${usuario}', true)`),
    ).rejects.toThrow(/permission denied/i);
  });
});
