import { MigrationInterface, QueryRunner } from "typeorm";

// Cola de trabajos durable (`tareas`) + estado de indexado RAG en `archivos`.
// Ver entidades Tarea.ts y Archivo.ts para el porqué.
export class AgregarTareasYEstadoIndexado1766000000000 implements MigrationInterface {
  name = "AgregarTareasYEstadoIndexado1766000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Estado de indexado RAG en archivos (separado de estadoEscaneo).
    await queryRunner.query(`ALTER TABLE "archivos" ADD "estadoIndexado" character varying`);
    await queryRunner.query(`ALTER TABLE "archivos" ADD "indexadoEn" TIMESTAMP WITH TIME ZONE`);

    // Tabla de la cola durable.
    await queryRunner.query(`
      CREATE TABLE "tareas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tipo" character varying NOT NULL,
        "archivoId" uuid NOT NULL,
        "usuarioId" uuid NOT NULL,
        "estado" character varying NOT NULL DEFAULT 'pendiente',
        "prioridad" integer NOT NULL DEFAULT 0,
        "intentos" integer NOT NULL DEFAULT 0,
        "maxIntentos" integer NOT NULL DEFAULT 3,
        "disponibleEn" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "pista" text,
        "error" text,
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        "actualizadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tareas" PRIMARY KEY ("id")
      )
    `);

    // FK con borrado en cascada: si se elimina definitivamente un archivo (o un
    // usuario), sus tareas pendientes desaparecen y no fallan al ejecutarse.
    await queryRunner.query(`
      ALTER TABLE "tareas"
        ADD CONSTRAINT "FK_tareas_archivo"
        FOREIGN KEY ("archivoId") REFERENCES "archivos"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "tareas"
        ADD CONSTRAINT "FK_tareas_usuario"
        FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE
    `);

    // Índice que usa el worker para reclamar la siguiente tarea disponible.
    await queryRunner.query(
      `CREATE INDEX "IDX_tareas_reclamo" ON "tareas" ("estado", "disponibleEn", "prioridad")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_tareas_reclamo"`);
    await queryRunner.query(`ALTER TABLE "tareas" DROP CONSTRAINT "FK_tareas_usuario"`);
    await queryRunner.query(`ALTER TABLE "tareas" DROP CONSTRAINT "FK_tareas_archivo"`);
    await queryRunner.query(`DROP TABLE "tareas"`);
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "indexadoEn"`);
    await queryRunner.query(`ALTER TABLE "archivos" DROP COLUMN "estadoIndexado"`);
  }
}
