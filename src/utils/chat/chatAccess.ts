import { db } from "../../config/db.js";

export type ChatAccess =
  | { ok: true; clearedAt: Date | null }
  | { ok: false; status: 403 | 404; error: string };

const DENIED: ChatAccess = {
  ok: false,
  status: 403,
  error: "You can't do this in this conversation.",
};

export const getChatAccess = async (
  userId: string,
  conversationId: string,
): Promise<ChatAccess> => {
  const participant = await db.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      leftAt: true,
      clearedAt: true,
      conversation: { select: { type: true, directKey: true } },
    },
  });

  if (!participant) {
    return { ok: false, status: 404, error: "Conversation not found." };
  }

  if (participant.leftAt) {
    return {
      ok: false,
      status: 403,
      error: "You are no longer a member of this conversation.",
    };
  }

  if (participant.conversation.type === "DIRECT") {
    const otherUserId = participant.conversation.directKey
      ?.split(":")
      .find((id) => id !== userId);

    if (!otherUserId) return DENIED;

    const [otherParticipant, block] = await Promise.all([
      db.conversationParticipant.findUnique({
        where: {
          conversationId_userId: { conversationId, userId: otherUserId },
        },
        select: { id: true },
      }),
      db.block.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedId: otherUserId },
            { blockerId: otherUserId, blockedId: userId },
          ],
        },
        select: { id: true },
      }),
    ]);

    if (!otherParticipant || block) return DENIED;
  }

  return { ok: true, clearedAt: participant.clearedAt };
};