import "dotenv/config";
import { disconnectDb } from "./config/db.js";
import app from "./app.js";
import { createServer } from "node:http";
import { closeSocketServer, initSocketServer } from "./socket/socketServer.js";

const requiredEnv = [
  "JWT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
  "BREVO_SMTP_USER",
  "BREVO_SMTP_KEY",
  "SENDER_EMAIL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing in environment variables.`);
  }
}

const PORT = Number(process.env.PORT) || 5000;

const httpServer = createServer(app);
initSocketServer(httpServer);

httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Relay Backend running on http://localhost:${PORT}`);
});

let isShuttingDown = false;

const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, shutting down...`);

  setTimeout(() => process.exit(1), 10_000).unref();

  closeSocketServer().then(async () => {
    try {
      await disconnectDb();
    } catch (error) {
      console.error("DB disconnect error:", error);
    }
    process.exit(0);
  });

  httpServer.closeIdleConnections();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));