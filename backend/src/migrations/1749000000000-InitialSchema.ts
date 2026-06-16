import { MigrationInterface, QueryRunner } from "typeorm";

// Esquema base: crea las tablas "usuarios" y "archivos" tal como estaban ANTES
// de la migracion AddPerfilUsuario (sin las columnas nombre/avatar, que las
// anade esa migracion posterior). Necesaria para arrancar sobre una BD vacia:
// hasta ahora el esquema base solo existia en BBDD creadas con synchronize.
export class InitialSchema1749000000000 implements MigrationInterface {
  name = "InitialSchema1749000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "usuarios" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "passwordHash" character varying NOT NULL,
        "rol" character varying NOT NULL DEFAULT 'user',
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usuarios_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_usuarios_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "archivos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nombre" character varying NOT NULL,
        "carpeta" character varying NOT NULL DEFAULT '/',
        "mimeType" character varying NOT NULL,
        "tamanoBytes" bigint NOT NULL,
        "claveMinio" character varying NOT NULL,
        "hashSha256" character varying,
        "textoExtraido" text,
        "eliminadoEn" TIMESTAMP,
        "propietarioId" uuid,
        "subidoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_archivos_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_archivos_claveMinio" UNIQUE ("claveMinio"),
        CONSTRAINT "FK_archivos_propietario" FOREIGN KEY ("propietarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_archivos_carpeta" ON "archivos" ("carpeta")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_archivos_carpeta"`);
    await queryRunner.query(`DROP TABLE "archivos"`);
    await queryRunner.query(`DROP TABLE "usuarios"`);
  }
}
