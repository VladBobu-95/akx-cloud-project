import { MigrationInterface, QueryRunner } from "typeorm";

// Índice para la deduplicación por hash (#4): la subida busca un archivo vivo
// del mismo usuario con el mismo SHA-256 antes de almacenar. La columna
// hashSha256 ya existía (sin usarse); aquí solo se indexa el par
// (propietario, hash) para que esa búsqueda sea eficiente.
export class IndiceHashArchivos1768000000000 implements MigrationInterface {
  name = "IndiceHashArchivos1768000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_archivos_propietario_hash" ON "archivos" ("propietarioId", "hashSha256")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_archivos_propietario_hash"`);
  }
}
