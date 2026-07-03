import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
} from "typeorm";
import { Usuario } from "./Usuario";
import { Archivo } from "./Archivo";
import { LineaFactura } from "./LineaFactura";

// Cabecera de una factura escaneada. Las cifras numéricas se guardan como string
// (TypeORM mapea numeric->string para no perder precisión).
@Entity("facturas")
export class Factura {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @ManyToOne(() => Usuario, { onDelete: "CASCADE" })
  propietario!: Usuario;

  // Fichero del que se extrajo (PDF/imagen). Nullable por si se borra el archivo.
  @ManyToOne(() => Archivo, { onDelete: "CASCADE", nullable: true })
  archivo?: Archivo | null;

  @Column({ nullable: true })
  numero?: string;

  // Fecha de la factura (clave para la analítica por periodo).
  @Column({ type: "date", nullable: true })
  fecha?: string | null;

  @Column({ nullable: true })
  emisor?: string;

  @Column({ type: "varchar", nullable: true })
  emisorNif?: string | null;

  @Column({ nullable: true })
  cliente?: string;

  @Column({ type: "varchar", nullable: true })
  clienteNif?: string | null;

  // "venta" (la empresa del propietario es el emisor) | "compra" (es el cliente) |
  // "desconocido" (no se pudo determinar). La analítica se separa por este campo:
  // resumen-ventas.md (ventas) vs resumen-compras.md (compras). Ver resolverDireccion.
  @Column({ type: "varchar", default: "desconocido" })
  tipo!: "venta" | "compra" | "desconocido";

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  subtotal!: string;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  iva!: string;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  total!: string;

  @Column({ default: "EUR" })
  moneda!: string;

  @OneToMany(() => LineaFactura, (l) => l.factura, { cascade: true })
  lineas!: LineaFactura[];

  @CreateDateColumn()
  creadoEn!: Date;
}
