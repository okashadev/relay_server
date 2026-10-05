import "dotenv/config";
import { disconnectDb } from "./config/db.js";

import app from "./app.js";

const requiredEnv = [
  "JWT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing in environment variables.`);
  }
}

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Relay Backend running on http://localhost:${PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);

  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
