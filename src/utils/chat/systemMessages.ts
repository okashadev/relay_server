import type { Prisma } from "@prisma/client";
import { messageSelect, type MessageRow } from "./messages.js";

export const createSystemMessage = async (
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    actorId: string;
    content: string;
    metadata: Prisma.InputJsonValue;
  },
): Promise<MessageRow> => {
  const message = await tx.message.create({
    data: {
      conversationId: input.conversationId,
      senderId: input.actorId,
      type: "SYSTEM",
      content: input.content,
      metadata: input.metadata,
    },
    select: messageSelect,
  });

  await tx.conversation.updateMany({
    where: {
      id: input.conversationId,
      lastMessageAt: { lt: message.createdAt },
    },
    data: { lastMessageAt: message.createdAt },
  });

  return message;
};