import { Prisma } from "@prisma/client";
import { db } from "../../config/db.js";
import { emitToUser } from "../../socket/socketServer.js";
import { SOCKET_EVENTS } from "../../socket/events.js";

export type Receipts = { deliveredUpTo: Date | null; readUpTo: Date | null };

type PointerRow = {
  conversationId: string;
  userId: string;
  lastDeliveredAt: Date | null;
  lastReadAt: Date | null;
};

const minPointer = (values: (Date | null)[]): Date | null => {
  let result: Date | null = null;

  for (const value of values) {
    if (value === null) return null;
    if (result === null || value.getTime() < result.getTime()) result = value;
  }

  return result;
};

const computeReceipts = (rows: PointerRow[]): Receipts => ({
  deliveredUpTo: minPointer(rows.map((row) => row.lastDeliveredAt)),
  readUpTo: minPointer(rows.map((row) => row.lastReadAt)),
});

const loadPointerRows = (conversationIds: string[]) =>
  db.conversationParticipant.findMany({
    where: { conversationId: { in: conversationIds }, leftAt: null },
    select: {
      conversationId: true,
      userId: true,
      lastDeliveredAt: true,
      lastReadAt: true,
    },
  });

export const getReceipts = async (conversationId: string): Promise<Receipts> =>
  computeReceipts(await loadPointerRows([conversationId]));

export const publishReceipts = async (conversationIds: string[]) => {
  if (conversationIds.length === 0) return;

  try {
    const rows = await loadPointerRows(conversationIds);
    const byConversation = new Map<string, PointerRow[]>();

    for (const row of rows) {
      const list = byConversation.get(row.conversationId) ?? [];
      list.push(row);
      byConversation.set(row.conversationId, list);
    }

    for (const [conversationId, members] of byConversation) {
      const receipts = computeReceipts(members);
      const payload = { conversationId, ...receipts };

      for (const member of members) {
        emitToUser(member.userId, SOCKET_EVENTS.RECEIPTS_UPDATED, payload);
      }
    }
  } catch (error) {
    console.error("Publish receipts failed:", error);
  }
};

export const markDelivered = async (
  conversationId: string,
  userIds: string[],
) => {
  if (userIds.length === 0) return;

  await db.$executeRaw`
    UPDATE "ConversationParticipant"
    SET "lastDeliveredAt" = now()
    WHERE "conversationId" = ${conversationId}
      AND "userId" IN (${Prisma.join(userIds)})
      AND "leftAt" IS NULL
  `;
};

const markAllDelivered = async (userId: string): Promise<string[]> => {
  const rows = await db.$queryRaw<{ conversationId: string }[]>`
    UPDATE "ConversationParticipant" cp
    SET "lastDeliveredAt" = now()
    FROM "Conversation" c
    WHERE cp."userId" = ${userId}
      AND cp."leftAt" IS NULL
      AND c."id" = cp."conversationId"
      AND (cp."lastDeliveredAt" IS NULL OR cp."lastDeliveredAt" < c."lastMessageAt")
    RETURNING cp."conversationId"
  `;

  return rows.map((row) => row.conversationId);
};

export const deliverPendingOnConnect = async (userId: string) => {
  try {
    await publishReceipts(await markAllDelivered(userId));
  } catch (error) {
    console.error("Deliver on connect failed:", error);
  }
};

export const markRead = async (
  conversationId: string,
  userId: string,
): Promise<boolean> => {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "ConversationParticipant" cp
    SET "lastReadAt" = now(), "lastDeliveredAt" = now()
    FROM "Conversation" c
    WHERE cp."conversationId" = ${conversationId}
      AND cp."userId" = ${userId}
      AND c."id" = cp."conversationId"
      AND (cp."lastReadAt" IS NULL OR cp."lastReadAt" < c."lastMessageAt")
    RETURNING cp."id"
  `;

  return rows.length > 0;
};
