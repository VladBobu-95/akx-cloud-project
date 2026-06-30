import { app } from "./app";
import { env } from "./config/env";
import { AppDataSource } from "./config/database";
import { inicializarBucket } from "./config/minio";
import { verificarModelosOllama } from "./config/ollama";
import { iniciarWorker } from "./services/tareas.service";
import { iniciarMantenimiento } from "./services/reconciliacion.service";
import { sembrarSuperadmin } from "./services/seed.service";

const main = async (): Promise<void> => {
  await AppDataSource.initialize();
  console.log("Base de datos conectada");

  // Bootstrap multi-tenant: asegura que exista el superadmin de la plataforma.
  await sembrarSuperadmin();

  await inicializarBucket();
  console.log("MinIO listo");

  await verificarModelosOllama();

  // Worker de la cola durable (indexado RAG + auto-escaneo de facturas).
  await iniciarWorker();

  // Mantenimiento periódico: reconciliación MinIO↔Postgres + retención de papelera.
  iniciarMantenimiento();

  app.listen(env.PORT, () => {
    console.log(`API escuchando en http://localhost:${env.PORT}`);
    console.log(`Entorno: ${env.NODE_ENV}`);
  });
};

main().catch((error) => {
  console.error("Error al arrancar:", error);
  process.exit(1);
});
