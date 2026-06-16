import { MigrationInterface, QueryRunner } from "typeorm";

// Añade las columnas de perfil al usuario: nombre de usuario e imagen (avatar).
// Ambas nullable para no romper los usuarios ya existentes.
export class AddPerfilUsuario1750000000000 implements MigrationInterface {
  name = "AddPerfilUsuario1750000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usuarios" ADD "nombre" character varying`);
    await queryRunner.query(`ALTER TABLE "usuarios" ADD "avatar" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "usuarios" DROP COLUMN "avatar"`);
    await queryRunner.query(`ALTER TABLE "usuarios" DROP COLUMN "nombre"`);
  }
}
