import { MigrationInterface, QueryRunner } from "typeorm";

// La capacidad "gestion_archivos" existía en el vocabulario y se veía como
// casilla al editar un rol, pero NO se comprobaba en ninguna parte: cualquier
// miembro podía subir, mover y borrar archivos aunque la tuviera desmarcada.
// Ahora sí se exige (rutas de /api/archivos y /api/compartido que modifican, y
// las tools/pre-flights equivalentes del chat).
//
// Los roles creados hasta hoy se marcaron sin saber que esa casilla no hacía
// nada, así que su estado actual no refleja ninguna decisión: si no se tocaran,
// al desplegar este cambio esos miembros perderían de golpe la gestión de sus
// propios archivos. Se les añade la capacidad para conservar el comportamiento
// que tienen hoy; a partir de ahora el admin decide quitándola a quien quiera
// dejar en solo lectura.
export class GestionArchivosARolesExistentes1778000000000 implements MigrationInterface {
  name = "GestionArchivosARolesExistentes1778000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "roles"
      SET "capacidades" = array_append("capacidades", 'gestion_archivos')
      WHERE NOT ('gestion_archivos' = ANY("capacidades"))
    `);
  }

  // No se revierte: quitar la capacidad a todos dejaría a esos roles en solo
  // lectura, que es justo lo que la migración evita. Si hace falta volver atrás,
  // basta con no exigirla en el código.
  public async down(): Promise<void> {
    /* intencionadamente vacío */
  }
}
