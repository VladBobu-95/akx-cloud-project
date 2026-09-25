import { MigrationInterface, QueryRunner } from "typeorm";

// Chat por SQL: el modelo ya no llama a tools ni hay pre-flights por regex; lee
// la BD escribiendo consultas SELECT que el backend ejecuta (chat.service.ts).
// Esta migración monta la frontera de seguridad de esas consultas y retira lo
// que dejó de usarse.
//
// Frontera (multi-tenant): las consultas del modelo corren con el rol
// "ateka_chat", que SOLO tiene SELECT sobre las vistas del esquema "chat". Cada
// vista se filtra por un token de acceso de un solo uso (tabla "chat_accesos",
// a la que ateka_chat NO tiene acceso): el backend inserta el token con el usuario
// y lo fija en la sesión (app.chat_token). Aunque el modelo reescriba ese
// ajuste, sin conocer el token de otro usuario (UUID aleatorio, vive segundos)
// las vistas no devuelven nada. `security_barrier` evita que un filtro del
// modelo con una función que falla (p. ej. un cast) se evalúe antes que el de la
// vista y filtre datos ajenos por el mensaje de error.
//
// El rol se crea NOLOGIN aquí; la contraseña y el LOGIN los pone el arranque
// (chatDb.ts), derivados de JWT_SECRET, para no guardar secretos en la migración.
//
// Se retira:
//  - "fragmentos" (embeddings bge-m3 de la búsqueda semántica).
//  - "chat_pendientes" (aclaraciones/confirmaciones del chat anterior).
export class ChatSql1779000000000 implements MigrationInterface {
  name = "ChatSql1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "fragmentos"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_pendientes"`);

    await queryRunner.query(`
      CREATE TABLE "chat_accesos" (
        "token" uuid NOT NULL,
        "usuarioId" uuid NOT NULL,
        "compartidas" uuid[] NOT NULL DEFAULT '{}',
        "puedeFacturas" boolean NOT NULL DEFAULT false,
        "puedeContenido" boolean NOT NULL DEFAULT false,
        "expiraEn" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_chat_accesos" PRIMARY KEY ("token"),
        CONSTRAINT "FK_chat_accesos_usuario" FOREIGN KEY ("usuarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE
      )
    `);

    // Los roles son de todo el cluster (la BD de tests comparte servidor).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ateka_chat') THEN
          CREATE ROLE ateka_chat NOLOGIN;
        END IF;
      END $$
    `);
    await queryRunner.query(`ALTER ROLE ateka_chat SET default_transaction_read_only = on`);
    await queryRunner.query(`ALTER ROLE ateka_chat SET statement_timeout = '10s'`);
    await queryRunner.query(`ALTER ROLE ateka_chat CONNECTION LIMIT 20`);

    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS chat`);

    // Sesión de chat activa (fila de chat_accesos del token fijado).
    const sesion = `JOIN public."chat_accesos" s
        ON s."token" = nullif(current_setting('app.chat_token', true), '')::uuid
       AND s."expiraEn" > now()`;

    await queryRunner.query(`
      CREATE VIEW chat.archivos WITH (security_barrier) AS
      SELECT a."id" AS archivo_id,
             a."nombre" AS nombre,
             a."carpeta" AS carpeta,
             cc."nombre" AS carpeta_compartida,
             a."mimeType" AS tipo_mime,
             a."tamanoBytes"::bigint AS tamano_bytes,
             a."subidoEn" AS subido_en,
             a."actualizadoEn" AS modificado_en,
             (a."eliminadoEn" IS NOT NULL) AS en_papelera,
             a."eliminadoEn" AS eliminado_en,
             CASE WHEN s."puedeContenido"
                  THEN nullif(concat_ws(E'\\n', a."descripcionManual", a."textoExtraido"), '')
             END AS contenido
      FROM public."archivos" a
      ${sesion}
      LEFT JOIN public."carpetas_compartidas" cc ON cc."id" = a."carpetaCompartidaId"
      WHERE (a."carpetaCompartidaId" IS NULL AND a."propietarioId" = s."usuarioId")
         OR (a."carpetaCompartidaId" = ANY (s."compartidas") AND a."eliminadoEn" IS NULL)
    `);

    await queryRunner.query(`
      CREATE VIEW chat.carpetas WITH (security_barrier) AS
      SELECT c."ruta" AS ruta, NULL::varchar AS carpeta_compartida, c."creadaEn" AS creada_en
      FROM public."carpetas" c
      ${sesion}
      WHERE c."propietarioId" = s."usuarioId"
      UNION ALL
      SELECT ccc."ruta", cc."nombre", ccc."creadaEn"
      FROM public."carpeta_compartida_carpetas" ccc
      JOIN public."carpetas_compartidas" cc ON cc."id" = ccc."carpetaCompartidaId"
      ${sesion}
      WHERE ccc."carpetaCompartidaId" = ANY (s."compartidas")
    `);

    await queryRunner.query(`
      CREATE VIEW chat.carpetas_compartidas WITH (security_barrier) AS
      SELECT cc."nombre" AS nombre, cc."creadoEn" AS creada_en
      FROM public."carpetas_compartidas" cc
      ${sesion}
      WHERE cc."id" = ANY (s."compartidas")
    `);

    // Facturas: solo las del usuario, sin las de archivos en la papelera (igual
    // que la analítica de la página Facturas) y solo con la capacidad "facturas".
    await queryRunner.query(`
      CREATE VIEW chat.facturas WITH (security_barrier) AS
      SELECT f."id" AS factura_id,
             f."archivoId" AS archivo_id,
             a."nombre" AS archivo,
             f."numero" AS numero,
             f."fecha" AS fecha,
             f."tipo" AS tipo,
             f."emisor" AS emisor,
             f."emisorNif" AS emisor_nif,
             f."cliente" AS cliente,
             f."clienteNif" AS cliente_nif,
             f."moneda" AS moneda,
             f."subtotal" AS subtotal,
             f."iva" AS iva,
             f."total" AS total
      FROM public."facturas" f
      ${sesion}
      LEFT JOIN public."archivos" a ON a."id" = f."archivoId"
      WHERE s."puedeFacturas"
        AND f."propietarioId" = s."usuarioId"
        AND (a."id" IS NULL OR a."eliminadoEn" IS NULL)
    `);

    await queryRunner.query(`
      CREATE VIEW chat.lineas_factura WITH (security_barrier) AS
      SELECT l."facturaId" AS factura_id,
             l."descripcion" AS descripcion,
             l."cantidad" AS cantidad,
             l."precioUnit" AS precio_unitario,
             l."total" AS total
      FROM public."lineas_factura" l
      JOIN chat.facturas f ON f.factura_id = l."facturaId"
    `);

    await queryRunner.query(`GRANT USAGE ON SCHEMA chat TO ateka_chat`);
    await queryRunner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA chat TO ateka_chat`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS chat CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_accesos"`);
    // El rol no se borra: es de todo el cluster y otra BD (tests) puede usarlo.
    // "fragmentos" y "chat_pendientes" no se recrean: sus datos no se pueden
    // recuperar y el código que los usaba ya no existe.
  }
}
