import { MigrationInterface, QueryRunner } from "typeorm";

// Añade la descripción manual de imágenes (modal "¿Qué es esta imagen?" al
// subir), guardada separada de textoExtraido para poder combinar ambas sin que
// una sobrescriba a la otra.
export class AgregarDescripcionManual1765000000000 implements MigrationInterface {
  name = "AgregarDescripcionManual1765000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "archivos" ADD "descripcionManual" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "descripcionManual"`);
  }
}
