import { MigrationInterface, QueryRunner } from "typeorm";

// Roles funcionales configurables por empresa (Fase 2) + relación N:N con usuarios.
//  - "roles": id, nombre, capacidades (text[]), empresaId (FK CASCADE), creadoEn.
//    Único (empresaId, nombre): el nombre de rol es único dentro de cada empresa.
//  - "usuario_roles": join N:N usuario↔rol (ambos FK CASCADE).
export class AgregarRoles1770000000000 implements MigrationInterface {
  name = "AgregarRoles1770000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nombre" character varying NOT NULL,
        "capacidades" text array NOT NULL DEFAULT '{}',
        "empresaId" uuid NOT NULL,
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roles_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_roles_empresa_nombre" UNIQUE ("empresaId", "nombre"),
        CONSTRAINT "FK_roles_empresa" FOREIGN KEY ("empresaId")
          REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "usuario_roles" (
        "usuarioId" uuid NOT NULL,
        "rolId" uuid NOT NULL,
        CONSTRAINT "PK_usuario_roles" PRIMARY KEY ("usuarioId", "rolId"),
        CONSTRAINT "FK_usuario_roles_usuario" FOREIGN KEY ("usuarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_usuario_roles_rol" FOREIGN KEY ("rolId")
          REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_usuario_roles_rol" ON "usuario_roles" ("rolId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_usuario_roles_rol"`);
    await queryRunner.query(`DROP TABLE "usuario_roles"`);
    await queryRunner.query(`DROP TABLE "roles"`);
  }
}
