import "reflect-metadata";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { AppDataSource } from "./config/database";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import authRoutes from "./routes/auth.routes";
import archivosRoutes from "./routes/archivos.routes";
import chatRoutes from "./routes/chat.routes";
import facturasRoutes from "./routes/facturas.routes";

export const app = express();

// La API corre detrás de nginx (Docker), que añade X-Forwarded-For.
// Confiar en el primer proxy permite que express-rate-limit identifique
// bien las IPs y evita el ValidationError de X-Forwarded-For.
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
// "*" = cualquier origen; si no, lista separada por comas (ej.
// "https://app.midominio.com,https://otro.com"). Ver CORS_ORIGIN en env.
const origenesCors =
  env.CORS_ORIGIN.trim() === "*"
    ? "*"
    : env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: origenesCors,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    entorno: env.NODE_ENV,
    db: AppDataSource.isInitialized,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/archivos", archivosRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/facturas", facturasRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use(errorHandler);
