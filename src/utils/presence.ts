import { db } from "../config/db.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import {
  emitToUser,
  emitToUsers,
  isUserConnected,
} from "../socket/socketServer.js";

const OFFLINE_GRACE_MS = 8_000;
const MAX_AUDIENCE = 1_000;

const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

const audienceIds = async (userId: string): Promise<string[]> => {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT audience."id"
    FROM (
        SELECT cp2."userId" AS "id"
        FROM "ConversationParticipant" cp1
        JOIN "ConversationParticipant" cp2
        ON cp2."conversationId" = cp1."conversationId"
       AND cp2."userId" <> cp1."userId"
      WHERE cp1."userId" = ${userId}
        AND cp1."leftAt" IS NULL
        AND cp2."leftAt" IS NULL
      UNION
      SELECT CASE WHEN f."senderId" = ${userId}
                  THEN f."receiverId" ELSE f."senderId" END AS "id"
      FROM "Friendship" f
      WHERE f."status" = 'ACCEPTED'
        AND (f."senderId" = ${userId} OR f."receiverId" = ${userId})
    ) audience
    WHERE NOT EXISTS (
      SELECT 1 FROM "Block" b
      WHERE (b."blockerId" = ${userId} AND b."blockedId" = audience."id")
         OR (b."blockerId" = audience."id" AND b."blockedId" = ${userId})
    )
    LIMIT ${MAX_AUDIENCE}
    
    `;

  return rows.map((row) => row.id);
};

export const getPresenceSnapshot = async (userId: string) => {
  const ids = await audienceIds(userId);
  if (ids.length === 0) return [];

  return db.user.findMany({
    where: { id: { in: ids }, isEmailVerified: true },
    select: { id: true, status: true, lastSeen: true },
  });
};

const broadcastPresence = async (
  userId: string,
  status: "ONLINE" | "OFFLINE",
  lastSeen: Date,
) => {
  const audience = await audienceIds(userId);

  emitToUsers(audience, SOCKET_EVENTS.PRESENCE_UPDATED, {
    userId,
    status,
    lastSeen,
  });
};

export const handleUserConnected = async (userId: string) => {
  const timer = offlineTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(userId);
  }

  try {
    const rows = await db.$queryRaw<{ lastSeen: Date }[]>`
      UPDATE "User" SET "status" = 'ONLINE'
      WHERE "id" = ${userId} AND "status" = 'OFFLINE'
      RETURNING "lastSeen"
    `;

    if (rows.length > 0)
      await broadcastPresence(userId, "ONLINE", rows[0].lastSeen);
  } catch (error: any) {
    console.error("Presence connect failed:", error);
  }
};

export const handleUserDisconnected = async (userId: string) => {
  if (isUserConnected(userId)) return;

  const existing = offlineTimers.get(userId);
  if (existing) clearTimeout(existing);

  offlineTimers.set(
    userId,
    setTimeout(async () => {
      offlineTimers.delete(userId);

      if (isUserConnected(userId)) return;

      try {
        const rows = await db.$queryRaw<{ lastSeen: Date }[]>`
          UPDATE "User" SET "status" = 'OFFLINE', "lastSeen" = now()
          WHERE "id" = ${userId} AND "status" = 'ONLINE'
          RETURNING "lastSeen"
        `;

        if (rows.length > 0) {
          await broadcastPresence(userId, "OFFLINE", rows[0].lastSeen);
        }
      } catch (error: any) {
        console.error("Presence disconnect failed:", error);
      }
    }, OFFLINE_GRACE_MS),
  );
};

export const resetStalePresence = async () => {
  await db.$executeRaw`
      UPDATE "User" SET "status" = 'OFFLINE', "lastSeen" = now()
      WHERE "status" = 'ONLINE'
    `;
};

export const hidePresenceBetween = (a: string, b: string) => {
  emitToUser(a, SOCKET_EVENTS.PRESENCE_UPDATED, {
    userId: b,
    status: "OFFLINE",
    lastSeen: null,
  });
  emitToUser(b, SOCKET_EVENTS.PRESENCE_UPDATED, {
    userId: a,
    status: "OFFLINE",
    lastSeen: null,
  });
};

export const revealPresenceBetween = async (a: string, b: string) => {
  try {
    const block = await db.block.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { id: true },
    });

    if (block) return;

    const users = await db.user.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true, status: true, lastSeen: true },
    });

    for (const user of users) {
      emitToUser(user.id === a ? b : a, SOCKET_EVENTS.PRESENCE_UPDATED, {
        userId: user.id,
        status: user.status,
        lastSeen: user.lastSeen,
      });
    }
  } catch (error: any) {
    console.error("Reveal presence failed:", error);
  }
};
