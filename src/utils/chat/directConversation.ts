import { db } from "../../config/db.js";
import { pairKey } from "../pairKey.js";

export const getOrCreateDirectConversation = async (
  userId: string,
  otherUserId: string,
): Promise<string> => {
  const key = pairKey(userId, otherUserId);

  const existing = await db.conversation.findUnique({
    where: { directKey: key },
    select: { id: true },
  });

  if (existing) return existing.id;

  try {
    const created = await db.conversation.create({
      data: {
        type: "DIRECT",
        directKey: key,
        participants: { create: [{ userId }, { userId: otherUserId }] },
      },
      select: { id: true },
    });

    return created.id;
  } catch (error: any) {
    if (error?.code !== "P2002") throw error;

    const winner = await db.conversation.findUnique({
      where: { directKey: key },
      select: { id: true },
    });

    if (!winner) throw error;
    return winner.id;
  }
};