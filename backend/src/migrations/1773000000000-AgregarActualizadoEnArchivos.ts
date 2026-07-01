import { MigrationInterface, QueryRunner } from "typeorm";

// Añade "actualizadoEn" (@UpdateDateColumn) a los archivos: fecha de la última
// modificación del registro (renombrar, mover, copiar, reindexar…). Es la "última
// actualización" que muestra el explorador de carpetas compartidas. Para las filas
// existentes se inicializa con "subidoEn" (no con la fecha de la migración), para
// que un archivo que nunca se ha tocado siga mostrando su fecha de subida.
export class AgregarActualizadoEnArchivos1773000000000 implements MigrationInterface {
  name = "AgregarActualizadoEnArchivos1773000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "archivos" ADD "actualizadoEn" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    // Backfill: los ya existentes arrancan con su fecha de subida.
    await queryRunner.query(`UPDATE "archivos" SET "actualizadoEn" = "subidoEn"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "actualizadoEn"`);
  }
}
