import { MigrationInterface, QueryRunner } from "typeorm";

// Fase 4: tablas de facturas y sus líneas (artículos). La cabecera guarda fecha,
// emisor, cliente y totales; cada línea, un artículo con cantidad/precio/total.
export class AgregarFacturas1762000000000 implements MigrationInterface {
  name = "AgregarFacturas1762000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "facturas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "numero" character varying,
        "fecha" date,
        "emisor" character varying,
        "cliente" character varying,
        "subtotal" numeric(12,2) NOT NULL DEFAULT 0,
        "iva" numeric(12,2) NOT NULL DEFAULT 0,
        "total" numeric(12,2) NOT NULL DEFAULT 0,
        "moneda" character varying NOT NULL DEFAULT 'EUR',
        "creadoEn" TIMESTAMP NOT NULL DEFAULT now(),
        "propietarioId" uuid,
        "archivoId" uuid,
        CONSTRAINT "PK_facturas_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_facturas_propietario" FOREIGN KEY ("propietarioId")
          REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_facturas_archivo" FOREIGN KEY ("archivoId")
          REFERENCES "archivos"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lineas_factura" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "descripcion" character varying NOT NULL,
        "cantidad" numeric(12,2) NOT NULL DEFAULT 0,
        "precioUnit" numeric(12,2) NOT NULL DEFAULT 0,
        "total" numeric(12,2) NOT NULL DEFAULT 0,
        "facturaId" uuid,
        CONSTRAINT "PK_lineas_factura_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lineas_factura_factura" FOREIGN KEY ("facturaId")
          REFERENCES "facturas"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_facturas_propietario" ON "facturas" ("propietarioId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lineas_factura_factura" ON "lineas_factura" ("facturaId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "lineas_factura"`);
    await queryRunner.query(`DROP TABLE "facturas"`);
  }
}
