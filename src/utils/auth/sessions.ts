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

  const keepRow = keep
    ? await client.refreshToken.findUnique({
        where: { token: keep },
        select: { deviceId: true },
      })
    : null;
  const keepDeviceId = keepRow?.deviceId ?? null;

  const { count } = await client.refreshToken.deleteMany({
    where: { userId, ...(keep ? { token: { not: keep } } : {}) },
  });

  const others = await client.device.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepDeviceId ? { id: { not: keepDeviceId } } : {}),
    },
    select: { id: true },
  });

  if (others.length > 0) {
    const ids = others.map((device) => device.id);

    await client.conversationDeviceKey.deleteMany({
      where: { deviceId: { in: ids } },
    });
    await client.device.updateMany({
      where: { id: { in: ids } },
      data: { revokedAt: new Date() },
    });
    await client.conversation.updateMany({
      where: { participants: { some: { userId, leftAt: null } } },
      data: { rekeyRequired: true },
    });
  }

  return count;
};
