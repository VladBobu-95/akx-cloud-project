import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";
import { Factura } from "./Factura";

// Una línea/artículo de una factura.
@Entity("lineas_factura")
export class LineaFactura {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @ManyToOne(() => Factura, (f) => f.lineas, { onDelete: "CASCADE" })
  factura!: Factura;

  @Column()
  descripcion!: string;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  cantidad!: string;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  precioUnit!: string;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  total!: string;
}
