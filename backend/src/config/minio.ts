import { Client } from "minio";
import { env } from "../config/env";

export const minioClient = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: false,
  accessKey: env.MINIO_USER,
  secretKey: env.MINIO_PASSWORD,
});

// Se llama al arrancar la API: crea el bucket si no existe.
export const inicializarBucket = async (): Promise<void> => {
  const existe = await minioClient.bucketExists(env.MINIO_BUCKET);
  if (!existe) {
    await minioClient.makeBucket(env.MINIO_BUCKET);
    console.log(`Bucket "${env.MINIO_BUCKET}" creado`);
  }
};
