import request from "supertest";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { AppDataSource } from "../src/config/database";
import { Archivo } from "../src/entities/Archivo";
import { minioClient } from "../src/config/minio";
import { env } from "../src/config/env";
import {
  reconciliarMinioPostgres,
  purgarPapeleraAntigua,
} from "../src/services/reconciliacion.service";
import { describe, it, expect, beforeAll } from "@jest/globals";

// Reconciliación MinIO↔Postgres + retención de papelera (#5).
describe("Reconciliación y retención (#5)", () => {
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const subir = (nombre: string) =>
    request(app)
      .post("/api/archivos/subir")
      .set(auth())
      .attach("archivo", Buffer.from(`contenido ${nombre} ${Date.now()}`), {
        filename: nombre,
        contentType: "text/plain",
      });

  const existeEnMinio = async (clave: string): Promise<boolean> => {
    try {
      await minioClient.statObject(env.MINIO_BUCKET, clave);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/registro")
      .send({ email: `recon_${Date.now()}@test.com`, password: "password123", nombre: "Recon" });
    token = reg.body.token;
  });

  it("borra objetos huérfanos (sin fila) y conserva los que sí tienen fila", async () => {
    // Objeto huérfano: existe en MinIO pero no hay fila que lo referencie.
    const claveHuerfana = `${randomUUID()}/huerfano-${randomUUID()}`;
    await minioClient.putObject(env.MINIO_BUCKET, claveHuerfana, Readable.from(Buffer.from("basura")), 6);

    // Archivo legítimo (objeto + fila).
    const up = await subir("legit.txt");
    const claveLegit = up.body.claveMinio as string;

    // margen 0: no esperamos 1h, borramos huérfanos "de ahora" para el test.
    const r = await reconciliarMinioPostgres(0);
    expect(r.huerfanosBorrados).toBeGreaterThanOrEqual(1);

    expect(await existeEnMinio(claveHuerfana)).toBe(false); // huérfano borrado
    expect(await existeEnMinio(claveLegit)).toBe(true); // legítimo conservado
  });

  it("detecta (sin borrar la fila) filas con objeto inexistente", async () => {
    const up = await subir("perdido.txt");
    const id = up.body.id as string;
    const clave = up.body.claveMinio as string;
    // Simula binario perdido: borramos el objeto pero dejamos la fila.
    await minioClient.removeObject(env.MINIO_BUCKET, clave);

    const r = await reconciliarMinioPostgres(0);
    expect(r.filasColgadas).toBeGreaterThanOrEqual(1);

    // La fila NO se borra (conservador): solo se loguea.
    const fila = await AppDataSource.getRepository(Archivo).findOne({ where: { id } });
    expect(fila).not.toBeNull();
  });

  it("retención: purga lo que lleva más de N días en la papelera", async () => {
    const up = await subir("viejo.txt");
    const id = up.body.id as string;
    const clave = up.body.claveMinio as string;
    await request(app).delete(`/api/archivos/${id}`).set(auth()); // a la papelera

    // Backdate del borrado a hace 10 días.
    const hace10d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await AppDataSource.query(`UPDATE "archivos" SET "eliminadoEn" = $1 WHERE "id" = $2`, [hace10d, id]);

    const r = await purgarPapeleraAntigua(7); // purga > 7 días
    expect(r.purgados).toBeGreaterThanOrEqual(1);

    // Desaparece de BD y de MinIO.
    const fila = await AppDataSource.getRepository(Archivo).findOne({ where: { id }, withDeleted: true });
    expect(fila).toBeNull();
    expect(await existeEnMinio(clave)).toBe(false);
  });

  it("retención desactivada (0 días) no purga nada", async () => {
    const up = await subir("reciente.txt");
    const id = up.body.id as string;
    await request(app).delete(`/api/archivos/${id}`).set(auth());
    const r = await purgarPapeleraAntigua(0);
    expect(r.purgados).toBe(0);
  });
});
