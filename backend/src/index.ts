import { app } from "./app";
import { env } from "./config/env";
import { AppDataSource } from "./config/database";
import { inicializarBucket } from "./config/minio";
import { verificarModelosOllama } from "./config/ollama";

const main = async (): Promise<void> => {
  await AppDataSource.initialize();
  console.log("Base de datos conectada");

  await inicializarBucket();
  console.log("MinIO listo");

  await verificarModelosOllama();

  app.listen(env.PORT, () => {
    console.log(`API escuchando en http://localhost:${env.PORT}`);
    console.log(`Entorno: ${env.NODE_ENV}`);
  });
};

main().catch((error) => {
  console.error("Error al arrancar:", error);
  process.exit(1);
});
