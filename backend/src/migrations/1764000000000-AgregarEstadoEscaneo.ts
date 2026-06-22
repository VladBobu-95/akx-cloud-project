import { MigrationInterface, QueryRunner } from "typeorm";

// Añade el estado de escaneo de factura a los archivos, para poder mostrarlo en
// el explorador (columna "Estado") sin tener que adivinarlo comprobando si existe
// una Factura asociada.
export class AgregarEstadoEscaneo1764000000000 implements MigrationInterface {
  name = "AgregarEstadoEscaneo1764000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "archivos" ADD "estadoEscaneo" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "estadoEscaneo"`);
  }
}
