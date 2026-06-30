import request from "supertest";
import { app } from "../src/app";
import { describe, it, expect, beforeAll } from "@jest/globals";

// Validación del avatar (#10): debe ser una imagen real (data-URL + magic bytes)
// y no superar el tope de tamaño decodificado. Antes se aceptaba cualquier
// string hasta 10 MB sin comprobar nada.
describe("Validación de avatar (#10)", () => {
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const patchAvatar = (avatar: string) =>
    request(app).patch("/api/auth/perfil").set(auth()).send({ avatar });

  // PNG 1x1 transparente válido.
  const PNG_1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/registro")
      .send({ email: `avatar_${Date.now()}@test.com`, password: "password123", nombre: "Avatar" });
    token = reg.body.token;
  });

  it("PNG válido -> 200", async () => {
    const res = await patchAvatar(PNG_1x1);
    expect(res.status).toBe(200);
    expect(res.body.usuario.avatar).toBe(PNG_1x1);
  });

  it('"" quita el avatar -> 200 y queda null', async () => {
    const res = await patchAvatar("");
    expect(res.status).toBe(200);
    expect(res.body.usuario.avatar).toBeNull();
  });

  it("texto que no es data-URL -> 400", async () => {
    const res = await patchAvatar("esto no es una imagen");
    expect(res.status).toBe(400);
  });

  it("data-URL de mime no permitido (html) -> 400", async () => {
    const res = await patchAvatar("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==");
    expect(res.status).toBe(400);
  });

  it("mime image/png pero bytes que no son PNG -> 400", async () => {
    const res = await patchAvatar(`data:image/png;base64,${Buffer.from("no soy png").toString("base64")}`);
    expect(res.status).toBe(400);
  });

  it("imagen demasiado grande (>2 MB) -> 400", async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2_200_000)]);
    const res = await patchAvatar(`data:image/png;base64,${big.toString("base64")}`);
    expect(res.status).toBe(400);
  });
});
