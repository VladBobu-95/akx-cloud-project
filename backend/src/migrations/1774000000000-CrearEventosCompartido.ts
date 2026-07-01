import { MigrationInterface, QueryRunner } from "typeorm";

// Registro de actividad (auditoría) de las carpetas compartidas: una fila por
// acción de usuario (subir, descargar, renombrar, mover, copiar, eliminar, y
// operaciones de subcarpeta). Filas pequeñas de solo metadatos; la retención
// periódica (RETENCION_LOGS_DIAS) purga lo más antiguo.
export class CrearEventosCompartido1774000000000 implements MigrationInterface {
  name = "CrearEventosCompartido1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "eventos_compartido" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "carpetaCompartidaId" uuid NOT NULL,
        "usuarioId" uuid,
        "usuarioNombre" character varying NOT NULL,
        "accion" character varying NOT NULL,
        "objeto" character varying,
        "ruta" character varying,
        "detalle" character varying,
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_eventos_compartido_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_eventos_cc_creado" ON "eventos_compartido" ("carpetaCompartidaId", "creadoEn")`,
    );
    await queryRunner.query(`
      ALTER TABLE "eventos_compartido"
        ADD CONSTRAINT "FK_eventos_cc" FOREIGN KEY ("carpetaCompartidaId")
        REFERENCES "carpetas_compartidas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "eventos_compartido"
        ADD CONSTRAINT "FK_eventos_usuario" FOREIGN KEY ("usuarioId")
        REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "eventos_compartido"`);
  }
}
