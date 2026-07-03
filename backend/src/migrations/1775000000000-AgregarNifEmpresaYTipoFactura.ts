import { MigrationInterface, QueryRunner } from "typeorm";

// Multi-tenant + facturas de compra y venta:
//  - empresas.nif: CIF/NIF de la empresa (tenant). Es el ancla fiable para decidir
//    si una factura es venta (el tenant es el emisor) o compra (es el cliente).
//    Nullable: no se pide al dar de alta; se AUTO-APRENDE al escanear la primera
//    factura que casa por nombre con la empresa (ver resolverDireccion), y el
//    admin puede corregirlo a mano. El nombre de empresa varía mucho entre
//    facturas ("AKX STUDIO, S.L." / "AKX Studio SLU" / "AKX ESTUDIO S.L."); el CIF no.
//  - facturas.tipo: "venta" | "compra" | "desconocido" (default). La analítica se
//    separa por tipo (resumen-ventas.md vs resumen-compras.md). Las facturas ya
//    escaneadas antes de este cambio quedan "desconocido" hasta re-escanearlas.
//  - facturas.emisorNif/clienteNif: NIF de cada parte, para anclar la dirección
//    por CIF cuando se conoce el de la empresa.
export class AgregarNifEmpresaYTipoFactura1775000000000 implements MigrationInterface {
  name = "AgregarNifEmpresaYTipoFactura1775000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "empresas" ADD "nif" character varying`);
    await queryRunner.query(
      `ALTER TABLE "facturas" ADD "tipo" character varying NOT NULL DEFAULT 'desconocido'`,
    );
    await queryRunner.query(`ALTER TABLE "facturas" ADD "emisorNif" character varying`);
    await queryRunner.query(`ALTER TABLE "facturas" ADD "clienteNif" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "facturas" DROP COLUMN "clienteNif"`);
    await queryRunner.query(`ALTER TABLE "facturas" DROP COLUMN "emisorNif"`);
    await queryRunner.query(`ALTER TABLE "facturas" DROP COLUMN "tipo"`);
    await queryRunner.query(`ALTER TABLE "empresas" DROP COLUMN "nif"`);
  }
}
