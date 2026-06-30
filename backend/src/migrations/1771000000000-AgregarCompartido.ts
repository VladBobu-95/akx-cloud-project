import { MigrationInterface, QueryRunner } from "typeorm";

// Carpetas compartidas por rol (Fase 3).
//  - "carpetas_compartidas": espacios compartidos de una empresa.
//  - "carpeta_compartida_roles": join N:N carpeta↔rol (qué roles acceden).
//  - "archivos"."carpetaCompartidaId" (nullable): si tiene valor el archivo vive
//    en una carpeta compartida (CASCADE: borrar la carpeta borra sus archivos).
//  - "fragmentos"."carpetaCompartidaId" (nullable): para que la búsqueda
//    semántica encuentre archivos compartidos a quien tiene acceso.
export class AgregarCompartido1771000000000 implements MigrationInterface {
  name = "AgregarCompartido1771000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "carpetas_compartidas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nombre" character varying NOT NULL,
        "empresaId" uuid NOT NULL,
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_carpetas_compartidas_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_carpcomp_empresa_nombre" UNIQUE ("empresaId", "nombre"),
        CONSTRAINT "FK_carpcomp_empresa" FOREIGN KEY ("empresaId")
          REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "carpeta_compartida_roles" (
        "carpetaCompartidaId" uuid NOT NULL,
        "rolId" uuid NOT NULL,
        CONSTRAINT "PK_carpcomp_roles" PRIMARY KEY ("carpetaCompartidaId", "rolId"),
        CONSTRAINT "FK_carpcomp_roles_carpeta" FOREIGN KEY ("carpetaCompartidaId")
          REFERENCES "carpetas_compartidas"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_carpcomp_roles_rol" FOREIGN KEY ("rolId")
          REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_carpcomp_roles_rol" ON "carpeta_compartida_roles" ("rolId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "archivos" ADD COLUMN "carpetaCompartidaId" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "archivos" ADD CONSTRAINT "FK_archivos_carpcomp"
        FOREIGN KEY ("carpetaCompartidaId") REFERENCES "carpetas_compartidas"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_archivos_carpcomp" ON "archivos" ("carpetaCompartidaId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "fragmentos" ADD COLUMN "carpetaCompartidaId" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_carpcomp" ON "fragmentos" ("carpetaCompartidaId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_fragmentos_carpcomp"`);
    await queryRunner.query(`ALTER TABLE "fragmentos" DROP COLUMN "carpetaCompartidaId"`);
    await queryRunner.query(`DROP INDEX "IDX_archivos_carpcomp"`);
    await queryRunner.query(`ALTER TABLE "archivos" DROP CONSTRAINT "FK_archivos_carpcomp"`);
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "carpetaCompartidaId"`);
    await queryRunner.query(`DROP INDEX "IDX_carpcomp_roles_rol"`);
    await queryRunner.query(`DROP TABLE "carpeta_compartida_roles"`);
    await queryRunner.query(`DROP TABLE "carpetas_compartidas"`);
  }
}
