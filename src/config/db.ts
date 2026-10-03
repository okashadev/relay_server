import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};

const pool = globalForPrisma.pool || new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForPrisma.pool = pool;

const adapter = new PrismaPg(pool);

export const db = globalForPrisma.prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;