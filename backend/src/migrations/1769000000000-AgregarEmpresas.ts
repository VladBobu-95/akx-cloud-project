import { MigrationInterface, QueryRunner } from "typeorm";

// Multi-tenant (Fase 1): tabla "empresas" y vínculo usuarios→empresa.
//  - Crea "empresas".
//  - Añade "empresaId" (nullable: null = superadmin de plataforma) a "usuarios".
//  - Backfill: si ya hay usuarios, crea una "Empresa por defecto" y mete a todos
//    los usuarios existentes en ella, para no romper datos previos.
//  - Migra el rol antiguo "user" → "miembro" y cambia el default de la columna.
export class AgregarEmpresas1769000000000 implements MigrationInterface {
  name = "AgregarEmpresas1769000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "empresas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nombre" character varying NOT NULL,
        "estado" character varying NOT NULL DEFAULT 'activa',
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_empresas_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`ALTER TABLE "usuarios" ADD COLUMN "empresaId" uuid`);
    await queryRunner.query(`
      ALTER TABLE "usuarios" ADD CONSTRAINT "FK_usuarios_empresa"
        FOREIGN KEY ("empresaId") REFERENCES "empresas"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_usuarios_empresa" ON "usuarios" ("empresaId")`,
    );

    // Backfill: solo si había usuarios previos (sobre BD vacía no creamos basura).
    const [{ n }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS n FROM "usuarios"`,
    );
    if (n > 0) {
      const [{ id }] = await queryRunner.query(
        `INSERT INTO "empresas" ("nombre", "estado")
         VALUES ('Empresa por defecto', 'activa') RETURNING "id"`,
      );
      await queryRunner.query(
        `UPDATE "usuarios" SET "empresaId" = $1 WHERE "empresaId" IS NULL`,
        [id],
      );
    }

    // Rol antiguo "user" → nuevo "miembro"; nuevo default de la columna.
    await queryRunner.query(
      `UPDATE "usuarios" SET "rol" = 'miembro' WHERE "rol" = 'user'`,
    );
    await queryRunner.query(
      `ALTER TABLE "usuarios" ALTER COLUMN "rol" SET DEFAULT 'miembro'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "usuarios" ALTER COLUMN "rol" SET DEFAULT 'user'`,
    );
    await queryRunner.query(
      `UPDATE "usuarios" SET "rol" = 'user' WHERE "rol" = 'miembro'`,
    );
    await queryRunner.query(`DROP INDEX "IDX_usuarios_empresa"`);
    await queryRunner.query(
      `ALTER TABLE "usuarios" DROP CONSTRAINT "FK_usuarios_empresa"`,
    );
    await queryRunner.query(`ALTER TABLE "usuarios" DROP COLUMN "empresaId"`);
    await queryRunner.query(`DROP TABLE "empresas"`);
  }
}
