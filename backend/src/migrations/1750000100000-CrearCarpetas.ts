import { MigrationInterface, QueryRunner } from "typeorm";

// Tabla de carpetas explícitas (incluidas las vacías), por usuario.
export class CrearCarpetas1750000100000 implements MigrationInterface {
  name = "CrearCarpetas1750000100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "carpetas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ruta" character varying NOT NULL,
        "creadaEn" TIMESTAMP NOT NULL DEFAULT now(),
        "propietarioId" uuid,
        CONSTRAINT "PK_carpetas_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_carpetas_propietario_ruta" UNIQUE ("propietarioId", "ruta"),
        CONSTRAINT "FK_carpetas_propietario" FOREIGN KEY ("propietarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "carpetas"`);
  }
}
