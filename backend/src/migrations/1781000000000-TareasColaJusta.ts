import { MigrationInterface, QueryRunner } from "typeorm";

// Cola justa por usuario (tareas.service.ts, reclamarSiguiente): el worker elige
// la tarea del usuario al que hace más tiempo que no atiende, calculado como el
// último "actualizadoEn" de sus tareas ya reclamadas. Este índice hace ese
// cálculo barato aunque la tabla acumule el histórico de tareas terminadas.
export class TareasColaJusta1781000000000 implements MigrationInterface {
  name = "TareasColaJusta1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tareas_usuario_actualizado" ON "tareas" ("usuarioId", "actualizadoEn")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tareas_usuario_actualizado"`);
  }
}
