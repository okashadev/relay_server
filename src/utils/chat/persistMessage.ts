import type { Prisma } from "@prisma/client";
import { db } from "../../config/db.js";
import { messageSelect } from "./messages.js";

export const persistMessage = (
  data: Prisma.MessageUncheckedCreateInput,
  conversationId: string,
  userId: string,
) =>
  db.$transaction(async (tx) => {
    const created = await tx.message.create({ data, select: messageSelect });

    await tx.conversation.updateMany({
      where: { id: conversationId, lastMessageAt: { lt: created.createdAt } },
      data: { lastMessageAt: created.createdAt },
    });

    await tx.$executeRaw`
      UPDATE "ConversationParticipant" cp
      SET "lastReadAt" = m."createdAt", "lastDeliveredAt" = m."createdAt"
      FROM "Message" m
      WHERE m."id" = ${created.id}
        AND cp."conversationId" = m."conversationId"
        AND cp."userId" = ${userId}
        AND (cp."lastReadAt" IS NULL OR cp."lastReadAt" < m."createdAt")
    `;

    return created;
  });
