import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../../config/db.js";
import { hashToken } from "../tokens.js";

export const REFRESH_COOKIE = "refreshToken";

type Client = typeof db | Prisma.TransactionClient;

export const revokeOtherSessions = async (
  userId: string,
  req: Request,
  client: Client = db,
) => {
  const current = req.cookies?.[REFRESH_COOKIE];
  const keep =
    typeof current === "string" && current ? hashToken(current) : null;

  const { count } = await client.refreshToken.deleteMany({
    where: { userId, ...(keep ? { token: { not: keep } } : {}) },
  });

  return count;
};