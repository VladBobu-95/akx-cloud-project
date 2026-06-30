import { MigrationInterface, QueryRunner } from "typeorm";

// Estado conversacional pendiente del chat fuera de memoria (#2). Ver
// ChatPendiente.ts.
export class AgregarChatPendientes1767000000000 implements MigrationInterface {
  name = "AgregarChatPendientes1767000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_pendientes" (
        "usuarioId" uuid NOT NULL,
        "tipo" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "expiraEn" TIMESTAMP WITH TIME ZONE NOT NULL,
        "actualizadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chat_pendientes" PRIMARY KEY ("usuarioId")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_pendientes"
        ADD CONSTRAINT "FK_chat_pendientes_usuario"
        FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_pendientes" DROP CONSTRAINT "FK_chat_pendientes_usuario"`,
    );
    await queryRunner.query(`DROP TABLE "chat_pendientes"`);
  }
}
