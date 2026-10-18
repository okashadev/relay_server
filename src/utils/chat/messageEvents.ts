import { db } from "../../config/db.js";
import { SOCKET_EVENTS } from "../../socket/events.js";
import { emitToUser, emitToUserWithAck } from "../../socket/socketServer.js";
import { messageSelect, serializeMessage, type MessageRow } from "./messages.js";
import { markDelivered, publishReceipts } from "../chat/receipts.js";

export const broadcastNewMessage = async (
  message: MessageRow,
  conversationId: string,
  senderId: string,
) => {
  try {
    const participants = await db.conversationParticipant.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true, clearedAt: true },
    });

    const results = await Promise.all(
      participants.map(async ({ userId, clearedAt }) => {
        const payload = {
          conversationId,
          message: serializeMessage(message, userId, clearedAt),
        };

        if (userId === senderId) {
          emitToUser(userId, SOCKET_EVENTS.MESSAGE_NEW, payload);
          return null;
        }

        const delivered = await emitToUserWithAck(
          userId,
          SOCKET_EVENTS.MESSAGE_NEW,
          payload,
        );

        return delivered ? userId : null;
      }),
    );

    const deliveredTo = results.filter((id): id is string => id !== null);

    if (deliveredTo.length > 0) {
      await markDelivered(conversationId, deliveredTo);
      await publishReceipts([conversationId]);
    }
  } catch (error) {
    console.error("Message broadcast failed:", error);
  }
};

export const broadcastMessageUpdated = async (
  conversationId: string,
  messageId: string,
) => {
  try {
    const [message, participants] = await Promise.all([
      db.message.findUnique({ where: { id: messageId }, select: messageSelect }),
      db.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true, clearedAt: true },
      }),
    ]);

    if (!message) return;

    for (const { userId, clearedAt } of participants) {
      emitToUser(userId, SOCKET_EVENTS.MESSAGE_UPDATED, {
        conversationId,
        message: serializeMessage(message, userId, clearedAt),
      });
    }
  } catch (error) {
    console.error("Message update broadcast failed:", error);
  }
};