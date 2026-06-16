import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from "typeorm";
import { Archivo } from "./Archivo";

@Entity("usuarios")
export class Usuario {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ nullable: true })
  nombre?: string; // nombre de usuario visible

  @Column({ type: "text", nullable: true })
  avatar?: string | null; // imagen de perfil (data URL base64); null = sin imagen

  @Column()
  passwordHash!: string;

  @Column({ default: "user" })
  rol!: string; // "user" | "admin"

  @CreateDateColumn()
  creadoEn!: Date;

  @OneToMany(() => Archivo, (archivo) => archivo.propietario)
  archivos!: Archivo[];
}
