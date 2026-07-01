import { MigrationInterface, QueryRunner } from "typeorm";

// Subcarpetas explícitas dentro de una carpeta compartida (paridad con "Mis
// archivos", que persiste sus carpetas en la tabla "carpetas"). Permite crear
// subcarpetas vacías que sobreviven aunque no tengan archivos. Borrar la carpeta
// compartida arrastra sus subcarpetas por el FK ON DELETE CASCADE.
export class AgregarSubcarpetasCompartidas1772000000000 implements MigrationInterface {
  name = "AgregarSubcarpetasCompartidas1772000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "carpeta_compartida_carpetas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ruta" character varying NOT NULL,
        "carpetaCompartidaId" uuid NOT NULL,
        "creadaEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_carpcomp_carpetas_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_carpcomp_carpetas_cc_ruta" UNIQUE ("carpetaCompartidaId", "ruta"),
        CONSTRAINT "FK_carpcomp_carpetas_cc" FOREIGN KEY ("carpetaCompartidaId")
          REFERENCES "carpetas_compartidas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "carpeta_compartida_carpetas"`);
  }
}
