import { MigrationInterface, QueryRunner } from "typeorm";

// Los resúmenes de facturas (resumen-ventas.md, resumen-compras.md y los
// resumen-<archivo>.md por factura) dejaron de materializarse como archivos en
// la carpeta "/facturas": ahora son datos DERIVADOS que se generan al vuelo
// desde la BD cuando el chat los pide (ver generarResumen*Md en
// facturas.service.ts). Esta migración limpia los que quedaron de la etapa
// anterior para que la carpeta oculta "/facturas" desaparezca de "Mis archivos",
// de "ver archivos" y de los listados del chat.
//
// Solo borra los .md AUTO-GENERADOS (mimeType markdown + nombre "resumen-*.md")
// que viven dentro de "/facturas": así se preserva cualquier archivo REAL que el
// usuario hubiera subido a esa carpeta. Los fragmentos RAG de esos .md caen por
// el FK CASCADE de "fragmentos"."archivoId". Los binarios en MinIO quedan
// huérfanos (invisibles e inofensivos; no hay acceso a MinIO desde una migración).
export class LimpiarResumenesFacturas1776000000000 implements MigrationInterface {
  name = "LimpiarResumenesFacturas1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // withDeleted implícito: DELETE por SQL alcanza también las copias en papelera.
    await queryRunner.query(`
      DELETE FROM "archivos"
       WHERE "mimeType" = 'text/markdown'
         AND "nombre" LIKE 'resumen-%.md'
         AND ("carpeta" = '/facturas' OR "carpeta" LIKE '/facturas/%')
    `);
    // Metadata de la carpeta "/facturas" (y subcarpetas). Si el usuario tuviera
    // archivos reales dentro, la carpeta reaparece derivada de sus rutas.
    await queryRunner.query(`
      DELETE FROM "carpetas"
       WHERE "ruta" = '/facturas' OR "ruta" LIKE '/facturas/%'
    `);
  }

  // No hay vuelta atrás: los resúmenes se regeneran solos desde la BD en cuanto
  // el chat los pide, así que "down" no necesita recrear nada.
  public async down(): Promise<void> {
    // no-op
  }
}
