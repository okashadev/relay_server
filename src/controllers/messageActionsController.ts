import type { Response } from "express";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { db } from "../config/db.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { emitToUser } from "../socket/socketServer.js";
import {
  deleteMessageQuerySchema,
  editMessageSchema,
  messageParamsSchema,
  reactionSchema,
} from "../validators/chatValidator.js";
import { getChatAccess, type ChatAccess } from "../utils/chatAccess.js";
import { deleteChatMedia } from "../utils/chatMedia.js";
import { broadcastMessageUpdated } from "../utils/messageEvents.js";
import { messageSelect, serializeMessage } from "../utils/messages.js";
import {
  badRequest,
  forbidden,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const DELETE_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;
const EDITABLE_TYPES = new Set<string>(["TEXT", "IMAGE", "VIDEO", "FILE"]);

const getUserId = (req: AuthenticatedRequest) => req.user?.userId;

const denyAccess = (res: Response, access: Extract<ChatAccess, { ok: false }>) =>
  res.status(access.status).json({ success: false, error: access.error });

export const editMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = messageParamsSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = editMessageSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId, messageId } = paramsResult.data;

    const access = await getChatAccess(userId, conversationId);
    if (!access.ok) return denyAccess(res, access);

    const message = await db.message.findFirst({
      where: { id: messageId, conversationId },
      select: messageSelect,
    });

    if (!message) return notFound(res, "Message not found.");

    if (message.senderId !== userId) {
      return forbidden(res, "You can only edit your own messages.");
    }
    if (message.deletedAt) return badRequest(res, "This message was deleted.");
    if (!EDITABLE_TYPES.has(message.type)) {
      return badRequest(res, "This message can't be edited.");
    }
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
      return badRequest(
        res,
        "You can only edit a message within 15 minutes of sending it.",
      );
    }

    const content = bodyResult.data.content;

    if (message.type === "TEXT" && content === "") {
      return badRequest(res, "Message can't be empty.");
    }

    const nextContent = content === "" ? null : content;

    if (nextContent === message.content) {
      return res.status(200).json({
        success: true,
        message: serializeMessage(message, userId, access.clearedAt),
      });
    }

    const updated = await db.message.update({
      where: { id: messageId },
      data: { content: nextContent, editedAt: new Date() },
      select: messageSelect,
    });

    res.status(200).json({
      success: true,
      message: serializeMessage(updated, userId, access.clearedAt),
    });

    void broadcastMessageUpdated(conversationId, messageId);
  } catch (error: any) {
    console.error("Edit Message Error:", error);
    return serverError(res);
  }
};

const cleanupMedia = async (url: string, ownerId: string, messageId: string) => {
  try {
    const stillUsed = await db.message.count({
      where: { mediaUrl: url, id: { not: messageId } },
    });

    if (stillUsed === 0) await deleteChatMedia(url, ownerId);
  } catch (error) {
    console.error("Media cleanup failed:", error);
  }
};

export const deleteMessage = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = messageParamsSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const queryResult = deleteMessageQuerySchema.safeParse(req.query);
    if (!queryResult.success) return validationError(res, queryResult.error);

    const { id: conversationId, messageId } = paramsResult.data;
    const { scope } = queryResult.data;

    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { clearedAt: true },
    });

    if (!participant) return notFound(res, "Conversation not found.");

    const message = await db.message.findFirst({
      where: { id: messageId, conversationId },
      select: messageSelect,
    });

    if (!message) return notFound(res, "Message not found.");

    if (scope === "me") {
      await db.messageDeletion.createMany({
        data: [{ messageId, userId }],
        skipDuplicates: true,
      });

      emitToUser(userId, SOCKET_EVENTS.MESSAGE_REMOVED, {
        conversationId,
        messageId,
      });

      return res.status(200).json({ success: true, messageId });
    }

    if (message.senderId !== userId) {
      return forbidden(res, "You can only delete your own messages for everyone.");
    }

    if (message.deletedAt) {
      return res.status(200).json({
        success: true,
        message: serializeMessage(message, userId, participant.clearedAt),
      });
    }

    if (Date.now() - message.createdAt.getTime() > DELETE_EVERYONE_WINDOW_MS) {
      return badRequest(
        res,
        "You can only delete a message for everyone within 2 days of sending it.",
      );
    }

    const mediaUrl = message.mediaUrl;

    const deleted = await db.$transaction(async (tx) => {
      await tx.messageReaction.deleteMany({ where: { messageId } });

      return tx.message.update({
        where: { id: messageId },
        data: {
          deletedAt: new Date(),
          content: null,
          mediaUrl: null,
          thumbnailUrl: null,
          mediaMimeType: null,
          fileName: null,
          mediaSize: null,
          mediaWidth: null,
          mediaHeight: null,
          mediaDuration: null,
        },
        select: messageSelect,
      });
    });

    res.status(200).json({
      success: true,
      message: serializeMessage(deleted, userId, participant.clearedAt),
    });

    void broadcastMessageUpdated(conversationId, messageId);
    if (mediaUrl) void cleanupMedia(mediaUrl, userId, messageId);
  } catch (error: any) {
    console.error("Delete Message Error:", error);
    return serverError(res);
  }
};

const findReactableMessage = (
  conversationId: string,
  messageId: string,
  userId: string,
  clearedAt: Date | null,
) =>
  db.message.findFirst({
    where: {
      id: messageId,
      conversationId,
      deletedAt: null,
      type: { not: "SYSTEM" },
      deletions: { none: { userId } },
      ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
    },
    select: { id: true },
  });

export const setReaction = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = messageParamsSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = reactionSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId, messageId } = paramsResult.data;
    const { emoji } = bodyResult.data;

    const access = await getChatAccess(userId, conversationId);
    if (!access.ok) return denyAccess(res, access);

    const target = await findReactableMessage(
      conversationId,
      messageId,
      userId,
      access.clearedAt,
    );

    if (!target) return notFound(res, "Message not found.");

    try {
      await db.messageReaction.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId, emoji },
        update: { emoji },
      });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;

      await db.messageReaction.update({
        where: { messageId_userId: { messageId, userId } },
        data: { emoji },
      });
    }

    const updated = await db.message.findUnique({
      where: { id: messageId },
      select: messageSelect,
    });

    if (!updated) return notFound(res, "Message not found.");

    res.status(200).json({
      success: true,
      message: serializeMessage(updated, userId, access.clearedAt),
    });

    void broadcastMessageUpdated(conversationId, messageId);
  } catch (error: any) {
    console.error("Set Reaction Error:", error);
    return serverError(res);
  }
};

export const removeReaction = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = messageParamsSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id: conversationId, messageId } = paramsResult.data;

    const access = await getChatAccess(userId, conversationId);
    if (!access.ok) return denyAccess(res, access);

    const target = await findReactableMessage(
      conversationId,
      messageId,
      userId,
      access.clearedAt,
    );

    if (!target) return notFound(res, "Message not found.");

    await db.messageReaction.deleteMany({ where: { messageId, userId } });

    const updated = await db.message.findUnique({
      where: { id: messageId },
      select: messageSelect,
    });

    if (!updated) return notFound(res, "Message not found.");

    res.status(200).json({
      success: true,
      message: serializeMessage(updated, userId, access.clearedAt),
    });

    void broadcastMessageUpdated(conversationId, messageId);
  } catch (error: any) {
    console.error("Remove Reaction Error:", error);
    return serverError(res);
  }
};