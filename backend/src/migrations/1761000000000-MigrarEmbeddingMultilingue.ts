import { MigrationInterface, QueryRunner } from "typeorm";

// Cambia la dimensión del embedding de 768 (nomic-embed-text) a 1024 (bge-m3,
// multilingüe, mucho mejor en español). Vacía los fragmentos existentes porque
// los vectores de 768 no son compatibles; se reindexarán al volver a subir.
export class MigrarEmbeddingMultilingue1761000000000 implements MigrationInterface {
  name = "MigrarEmbeddingMultilingue1761000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fragmentos_embedding"`);
    await queryRunner.query(`TRUNCATE TABLE "fragmentos"`);
    await queryRunner.query(
      `ALTER TABLE "fragmentos" ALTER COLUMN "embedding" TYPE vector(1024)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_embedding" ON "fragmentos" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fragmentos_embedding"`);
    await queryRunner.query(`TRUNCATE TABLE "fragmentos"`);
    await queryRunner.query(
      `ALTER TABLE "fragmentos" ALTER COLUMN "embedding" TYPE vector(768)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_embedding" ON "fragmentos" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }
}
