import { MigrationInterface, QueryRunner } from "typeorm";

// Habilita la extensión "unaccent" de Postgres para que los filtros de cliente/
// emisor/producto en las facturas (ILIKE) ignoren tildes: sin esto, "Tecnologias"
// (sin tilde, lo más común al escribir rápido) no encontraba "Tecnologías".
export class HabilitarUnaccent1763000000000 implements MigrationInterface {
  name = "HabilitarUnaccent1763000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No quitamos la extensión: podría usarla otra cosa.
  }
}
