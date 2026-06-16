import { MigrationInterface, QueryRunner } from "typeorm";

// RAG (Fase 3): activa pgvector y crea la tabla de fragmentos (chunks) con su
// embedding. Cada archivo se trocea en fragmentos y cada uno guarda su vector
// para la búsqueda semántica. nomic-embed-text produce vectores de 768 dims.
export class AgregarRagFragmentos1760000000000 implements MigrationInterface {
  name = "AgregarRagFragmentos1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await queryRunner.query(`
      CREATE TABLE "fragmentos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "archivoId" uuid NOT NULL,
        "propietarioId" uuid NOT NULL,
        "indice" integer NOT NULL DEFAULT 0,
        "texto" text NOT NULL,
        "embedding" vector(768),
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_fragmentos_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_fragmentos_archivo" FOREIGN KEY ("archivoId")
          REFERENCES "archivos"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_fragmentos_propietario" FOREIGN KEY ("propietarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // Índice de similitud por coseno (HNSW) para ORDER BY embedding <=> consulta.
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_embedding" ON "fragmentos" USING hnsw ("embedding" vector_cosine_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_propietario" ON "fragmentos" ("propietarioId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fragmentos_archivo" ON "fragmentos" ("archivoId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "fragmentos"`);
    // No quitamos la extensión vector: podría usarla otra cosa.
  }
}
