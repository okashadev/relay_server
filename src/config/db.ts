import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined in environment variables");
}

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

const adapter = new PrismaPg(pool);

export const db = new PrismaClient({
  adapter,
  log: isProduction ? ["error"] : ["warn", "error"],
});

export const disconnectDb = async () => {
  await db.$disconnect();
  if (!pool.ended) await pool.end();
};
