import { MigrationInterface, QueryRunner } from "typeorm";

// Añade `procesando` a la vista chat.archivos: true mientras el archivo recién
// subido sigue en la cola (extrayendo texto o escaneando la factura). Sin esto,
// si el usuario preguntaba por una factura nada más subirla, el chat no la
// encontraba y respondía como si no existiera; ahora puede decir que se está
// procesando. CREATE OR REPLACE solo permite añadir columnas al final.
const vista = (conProcesando: boolean): string => `
  CREATE OR REPLACE VIEW chat.archivos WITH (security_barrier) AS
  SELECT a."id" AS archivo_id,
         a."nombre" AS nombre,
         a."carpeta" AS carpeta,
         cc."nombre" AS carpeta_compartida,
         a."mimeType" AS tipo_mime,
         a."tamanoBytes"::bigint AS tamano_bytes,
         a."subidoEn" AS subido_en,
         a."actualizadoEn" AS modificado_en,
         (a."eliminadoEn" IS NOT NULL) AS en_papelera,
         a."eliminadoEn" AS eliminado_en,
         CASE WHEN s."puedeContenido"
              THEN nullif(concat_ws(E'\\n', a."descripcionManual", a."textoExtraido"), '')
         END AS contenido${
           conProcesando
             ? `,
         (coalesce(a."estadoIndexado", '') IN ('pendiente', 'indexando')
          OR coalesce(a."estadoEscaneo", '') IN ('pendiente', 'escaneando')) AS procesando`
             : ""
         }
  FROM public."archivos" a
  JOIN public."chat_accesos" s
    ON s."token" = nullif(current_setting('app.chat_token', true), '')::uuid
   AND s."expiraEn" > now()
  LEFT JOIN public."carpetas_compartidas" cc ON cc."id" = a."carpetaCompartidaId"
  WHERE (a."carpetaCompartidaId" IS NULL AND a."propietarioId" = s."usuarioId")
     OR (a."carpetaCompartidaId" = ANY (s."compartidas") AND a."eliminadoEn" IS NULL)
`;

export class ChatArchivosProcesando1780000000000 implements MigrationInterface {
  name = "ChatArchivosProcesando1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(vista(true));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Quitar una columna exige recrear la vista (y volver a darle permiso).
    await queryRunner.query(`DROP VIEW chat.archivos`);
    await queryRunner.query(vista(false));
    await queryRunner.query(`GRANT SELECT ON chat.archivos TO ateka_chat`);
  }
}
