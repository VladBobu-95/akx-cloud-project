import { MigrationInterface, QueryRunner } from "typeorm";

export class AgregarClavesApi1777000000000 implements MigrationInterface {
  name = "AgregarClavesApi1777000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "claves_api" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nombre" character varying NOT NULL DEFAULT 'n8n',
        "prefijo" character varying NOT NULL,
        "hash" character varying NOT NULL,
        "usuarioId" uuid NOT NULL,
        "empresaId" uuid,
        "ultimoUso" TIMESTAMP,
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        "revocadaEn" TIMESTAMP,
        CONSTRAINT "PK_claves_api_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_claves_api_hash" UNIQUE ("hash"),
        CONSTRAINT "FK_claves_api_usuario" FOREIGN KEY ("usuarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_claves_api_empresa" FOREIGN KEY ("empresaId")
          REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_claves_api_usuario_revocada" ON "claves_api" ("usuarioId", "revocadaEn")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_claves_api_usuario_revocada"`);
    await queryRunner.query(`DROP TABLE "claves_api"`);
  }
};
