import type { Socket } from "socket.io";
import z from "zod";
import { handleUserConnected, handleUserDisconnected } from "../utils/presence.js";
import { deliverPendingOnConnect } from "../utils/chat/receipts.js";
import { getChatAccess } from "../utils/chat/chatAccess.js";
import { db } from "../config/db.js";
import { emitToUsers } from "./socketServer.js";
import { CLIENT_EVENTS, SOCKET_EVENTS } from "./events.js";

const payloadSchema = z.object({ conversationId: z.uuid() });

const CONTEXT_TTL_MS = 60_000;
const START_THROTTLE_MS = 1_000;
const MAX_RECIPIENTS = 200;

type TypingContext = { name: string; recipients: string[] };

export const registerSocketHandlers = (socket: Socket) => {
  const userId = socket.data.userId as string;

  void handleUserConnected(userId);
  void deliverPendingOnConnect(userId);

  const context = new Map<
    string,
    { value: TypingContext | null; expiresAt: number }
  >();

  const lastStart = new Map<string, number>();

  const resolveContext = async (conversationId: string) => {
    const cached = context.get(conversationId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const [access, recipients, me] = await Promise.all([
      getChatAccess(userId, conversationId),
      db.conversationParticipant.findMany({
        where: { conversationId, leftAt: null, userId: { not: userId } },
        select: { userId: true },
        take: MAX_RECIPIENTS,
      }),
      db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);

    const value =
      access.ok && me
        ? { name: me.name, recipients: recipients.map((r) => r.userId) }
        : null;

    context.set(conversationId, {
      value,
      expiresAt: Date.now() + CONTEXT_TTL_MS,
    });

    return value;
  };

  const handleTyping = async (isTyping: boolean, payload: unknown) => {
    try {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) return;

      const { conversationId } = parsed.data;

      if (isTyping) {
        const now = Date.now();
        if (now - (lastStart.get(conversationId) ?? 0) < START_THROTTLE_MS)
          return;
        lastStart.set(conversationId, now);
      }

      const context = await resolveContext(conversationId);
      if (!context) return;

      emitToUsers(context.recipients, SOCKET_EVENTS.TYPING_UPDATED, {
        conversationId,
        userId,
        name: context.name,
        isTyping,
      });
    } catch (error: any) {
      console.error("Typing event failed:", error);
    }
  };

  socket.on(
    CLIENT_EVENTS.TYPING_START,
    (payload) => void handleTyping(true, payload),
  );

  socket.on(
    CLIENT_EVENTS.TYPING_STOP,
    (payload) => void handleTyping(false, payload),
  );

  socket.on("disconnect", () => handleUserDisconnected(userId));
};
