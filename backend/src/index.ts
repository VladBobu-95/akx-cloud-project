import { Server } from "http";
import { app } from "./app";
import { env } from "./config/env";
import { AppDataSource } from "./config/database";
import { inicializarBucket } from "./config/minio";
import { verificarModelosOllama } from "./config/ollama";
import { iniciarWorker, detenerWorker } from "./services/tareas.service";
import { iniciarMantenimiento, detenerMantenimiento } from "./services/reconciliacion.service";
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

  const server = app.listen(env.PORT, () => {
    console.log(`API escuchando en http://localhost:${env.PORT}`);
    console.log(`Entorno: ${env.NODE_ENV}`);
  });

  instalarApagadoOrdenado(server);
};

// Apagado ordenado: Docker manda SIGTERM al hacer `stop`/redeploy (y SIGINT con
// Ctrl-C en local). Dejamos de aceptar conexiones, paramos el mantenimiento y el
// worker (que espera a que terminen los bucles en vuelo) y cerramos la BD, en vez
// de morir en seco. Una tarea a medias se reencola igual al reiniciar (cola
// durable), pero así no cortamos una petición HTTP ni una tarea a mitad.
const instalarApagadoOrdenado = (server: Server): void => {
  let apagando = false;
  const cerrar = async (senal: string): Promise<void> => {
    if (apagando) return; // ignora una segunda señal mientras ya cerramos
    apagando = true;
    console.log(`\n[apagado] ${senal} recibido, cerrando ordenadamente…`);
    // Deja de aceptar conexiones nuevas (no corta el proceso hasta drenar).
    server.close();
    detenerMantenimiento();
    await detenerWorker();
    await AppDataSource.destroy();
    console.log("[apagado] listo.");
    process.exit(0);
  };
  process.on("SIGTERM", () => void cerrar("SIGTERM"));
  process.on("SIGINT", () => void cerrar("SIGINT"));
};

main().catch((error) => {
  console.error("Error al arrancar:", error);
  process.exit(1);
});
