import { Response } from "express";
import { db } from "../config/db.js";
import { Prisma } from "@prisma/client";
import { pairKey } from "../utils/pairKey.js";
import { getUserId } from "../utils/getUserId.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { emitToUser } from "../socket/socketServer.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";
import { chatSettingsSchema } from "../validators/chatValidator.js";
import { broadcastNewMessage } from "../utils/chat/messageEvents.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { LastMessageRow, OtherUser } from "../types/conversationTypes.js";
import { toConversationResponse, truncate } from "../utils/chat/chatHelpers.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import {
  conversationIdParamSchema,
  messagesQuerySchema,
  newChatSchema,
  sendMessageSchema,
} from "../validators/chatValidator.js";
import {
  MessageRow,
  messageSelect,
  serializeMessage,
} from "../utils/chat/messages.js";
import {
  isOwnPublicId,
  sanitizeFileName,
  VerifiedMedia,
  verifyChatMedia,
} from "../utils/chat/chatMedia.js";
import {
  getReceipts,
  markRead,
  publishReceipts,
} from "../utils/chat/receipts.js";
import {
  conversationSelect,
  DELETED_USER,
  listUserSelect,
  MAX_CHATS,
  MAX_MEMBERS,
  MAX_PINNED_CHATS,
  MUTE_DURATIONS_MS,
  MUTE_FOREVER,
  otherUserSelect,
  UNREAD_CAP,
} from "../utils/chat/chatConstants.js";

export const newChat = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);

    if (!userId) return unauthorized(res);

    const validationResult = newChatSchema.safeParse(req.body);

    if (!validationResult.success)
      return validationError(res, validationResult.error);

    const { otherUserId } = validationResult.data;

    if (userId === otherUserId)
      return badRequest(res, "You cannot start a chat with yourself.");

    const key = pairKey(userId, otherUserId);

    const [otherUser, existing, block] = await Promise.all([
      db.user.findFirst({
        where: { id: otherUserId, isEmailVerified: true },
        select: otherUserSelect,
      }),
      db.conversation.findUnique({
        where: { directKey: key },
        select: conversationSelect(userId),
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

    if (!otherUser) return notFound(res, "User not found.");

    res.set("Cache-Control", "no-store");

    if (existing) {
      const visibleUser: OtherUser = block
        ? { ...otherUser, status: "OFFLINE", lastSeen: null }
        : otherUser;

      return res.status(200).json({
        success: true,
        conversation: toConversationResponse(existing, visibleUser),
      });
    }

    if (block) return notFound(res, "User not found.");

    const friendship = await db.friendship.findUnique({
      where: { pairKey: key },
      select: { status: true },
    });

    if (friendship?.status !== "ACCEPTED") {
      return forbidden(res, "You can only start a chat with your friends.");
    }
    try {
      const created = await db.conversation.create({
        data: {
          type: "DIRECT",
          directKey: key,
          participants: {
            create: [{ userId }, { userId: otherUserId }],
          },
        },
        select: conversationSelect(userId),
      });

      return res.status(201).json({
        success: true,
        conversation: toConversationResponse(created, otherUser),
      });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;

      const winner = await db.conversation.findUnique({
        where: { directKey: key },
        select: conversationSelect(userId),
      });

      if (!winner) throw error;

      return res.status(200).json({
        success: true,
        conversation: toConversationResponse(winner, otherUser),
      });
    }
  } catch (error: any) {
    console.error("New Chat Error:", error);
    return serverError(res);
  }
};

export const getMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const queryResult = messagesQuerySchema.safeParse(req.query);
    if (!queryResult.success) return validationError(res, queryResult.error);

    const { id: conversationId } = paramsResult.data;
    const { cursor, limit } = queryResult.data;

    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decodedCursor) return badRequest(res, "Invalid cursor.");

    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { clearedAt: true, leftAt: true },
    });

    if (!participant) return notFound(res, "Conversation not found.");

    const { clearedAt, leftAt } = participant;

    const filters: Prisma.MessageWhereInput[] = [
      { conversationId },
      { deletions: { none: { userId } } },
    ];

    if (clearedAt) filters.push({ createdAt: { gt: clearedAt } });

    if (leftAt) filters.push({ createdAt: { lte: leftAt } });

    if (decodedCursor) {
      filters.push({
        OR: [
          { createdAt: { lt: decodedCursor.createdAt } },
          {
            createdAt: decodedCursor.createdAt,
            id: { lt: decodedCursor.id },
          },
        ],
      });
    }

    const rows = await db.message.findMany({
      where: { AND: filters },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: messageSelect,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page[page.length - 1];

    const items = page
      .map((message) => serializeMessage(message, userId, clearedAt))
      .reverse();

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      items,
      nextCursor:
        hasMore && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
    });
  } catch (error: any) {
    console.error("Get Messages Error:", error);
    return serverError(res);
  }
};

export const getConversation = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramResult.success) return validationError(res, paramResult.error);

    const { id } = paramResult.data;

    const [conversation, mine, receipts] = await Promise.all([
      db.conversation.findUnique({
        where: {
          id,
        },
        select: {
          id: true,
          type: true,
          name: true,
          avatar: true,
          description: true,
          lastMessageAt: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
          participants: {
            select: { role: true, user: { select: otherUserSelect } },
            orderBy: { joinedAt: "asc" },
            take: MAX_MEMBERS,
          },
        },
      }),

      db.conversationParticipant.findUnique({
        where: {
          conversationId_userId: {
            conversationId: id,
            userId,
          },
        },
        select: {
          role: true,
          mutedUntil: true,
          pinnedAt: true,
          isArchived: true,
          leftAt: true,
        },
      }),
      getReceipts(id),
    ]);

    if (!conversation || !mine) return notFound(res, "Conversation not found.");

    const me = {
      isMuted: Boolean(mine.mutedUntil && mine.mutedUntil > new Date()),
      isPinned: Boolean(mine.pinnedAt),
      isArchived: mine.isArchived,
    };

    res.set("Cache-Control", "no-store");

    if (conversation.type === "GROUP") {
      return res.status(200).json({
        success: true,
        conversation: {
          id: conversation.id,
          type: "GROUP" as const,
          name: conversation.name ?? "Group",
          avatar: conversation.avatar,
          description: conversation.description,
          createdAt: conversation.createdAt,
          createdBy: conversation.createdBy,
          myRole: mine.role,
          members: conversation.participants.map(({ role, user }) => ({
            user,
            role,
          })),
          me,
          receipts,
          blockedByMe: false,
          canSend: mine.leftAt === null,
        },
      });
    }

    const other = conversation.participants.find(
      (participant) => participant.user.id !== userId,
    )?.user;

    let otherUser: OtherUser = other ?? DELETED_USER;
    let blockedByMe = false;
    let blockedEitherWay = false;

    if (other) {
      const blocks = await db.block.findMany({
        where: {
          OR: [
            { blockerId: userId, blockedId: other.id },
            { blockerId: other.id, blockedId: userId },
          ],
        },
        select: { blockerId: true },
      });

      blockedEitherWay = blocks.length > 0;
      blockedByMe = blocks.some((block) => block.blockerId === userId);

      if (blockedEitherWay) {
        otherUser = { ...other, status: "OFFLINE", lastSeen: null };
      }
    }

    return res.status(200).json({
      success: true,
      conversation: {
        id: conversation.id,
        type: "DIRECT" as const,
        lastMessageAt: conversation.lastMessageAt,
        createdAt: conversation.createdAt,
        otherUser,
        me,
        receipts,
        blockedByMe,
        canSend: Boolean(other) && !blockedEitherWay && mine.leftAt === null,
      },
    });
  } catch (error: any) {
    console.error("Get Conversation Error:", error);
    return serverError(res);
  }
};

export const getChatsList = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const participants = await db.conversationParticipant.findMany({
      where: { userId },
      orderBy: [
        { pinnedAt: { sort: "desc", nulls: "last" } },
        { conversation: { lastMessageAt: "desc" } },
      ],
      take: MAX_CHATS,
      select: {
        conversationId: true,
        mutedUntil: true,
        pinnedAt: true,
        isArchived: true,
        conversation: {
          select: {
            type: true,
            name: true,
            avatar: true,
            participants: {
              where: { userId: { not: userId } },
              take: 1,
              select: { user: { select: listUserSelect } },
            },
          },
        },
      },
    });

    res.set("Cache-Control", "no-store");

    if (participants.length === 0) {
      return res.status(200).json({ success: true, chats: [] });
    }

    const conversationIds = participants.map((p) => p.conversationId);
    const otherUserIds = participants.flatMap((p) => {
      const other = p.conversation.participants[0]?.user;
      return p.conversation.type === "DIRECT" && other ? [other.id] : [];
    });

    const [rows, blocks] = await Promise.all([
      db.$queryRaw<LastMessageRow[]>`
        SELECT
          cp."conversationId",
          lm."type",
          lm."content",
          lm."fileName",
          lm."senderId",
          lm."deletedAt",
          lm."createdAt",
          sender."name" AS "senderName",
          unread."count" AS "unreadCount"
        FROM "ConversationParticipant" cp
        JOIN LATERAL (
          SELECT m."type", m."content", m."fileName", m."senderId",
                 m."deletedAt", m."createdAt"
          FROM "Message" m
          WHERE m."conversationId" = cp."conversationId"
            AND (cp."clearedAt" IS NULL OR m."createdAt" > cp."clearedAt")
            AND (cp."leftAt" IS NULL OR m."createdAt" <= cp."leftAt")
            AND NOT EXISTS (
              SELECT 1 FROM "MessageDeletion" d
              WHERE d."messageId" = m."id" AND d."userId" = cp."userId"
            )
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT 1
        ) lm ON true
        LEFT JOIN "User" sender ON sender."id" = lm."senderId"
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS "count"
          FROM (
            SELECT 1
            FROM "Message" m
            WHERE m."conversationId" = cp."conversationId"
              AND m."senderId" IS DISTINCT FROM cp."userId"
              AND m."type" <> 'SYSTEM'
              AND m."deletedAt" IS NULL
              AND (cp."lastReadAt" IS NULL OR m."createdAt" > cp."lastReadAt")
              AND (cp."clearedAt" IS NULL OR m."createdAt" > cp."clearedAt")
              AND (cp."leftAt" IS NULL OR m."createdAt" <= cp."leftAt")
              AND NOT EXISTS (
                SELECT 1 FROM "MessageDeletion" d
                WHERE d."messageId" = m."id" AND d."userId" = cp."userId"
              )
            LIMIT ${UNREAD_CAP}
          ) capped
        ) unread
        WHERE cp."userId" = ${userId}
          AND cp."conversationId" IN (${Prisma.join(conversationIds)})
      `,
      otherUserIds.length > 0
        ? db.block.findMany({
            where: {
              OR: [
                { blockerId: userId, blockedId: { in: otherUserIds } },
                { blockedId: userId, blockerId: { in: otherUserIds } },
              ],
            },
            select: { blockerId: true, blockedId: true },
          })
        : Promise.resolve<{ blockerId: string; blockedId: string }[]>([]),
    ]);

    const rowByConversation = new Map(
      rows.map((row) => [row.conversationId, row]),
    );
    const blockedByMeIds = new Set(
      blocks
        .filter((block) => block.blockerId === userId)
        .map((b) => b.blockedId),
    );
    const blockedAnyIds = new Set(
      blocks.map((block) =>
        block.blockerId === userId ? block.blockedId : block.blockerId,
      ),
    );

    const now = new Date();

    const entries = participants.flatMap((participant) => {
      const row = rowByConversation.get(participant.conversationId);

      if (!row) return [];

      const { conversation } = participant;
      const other = conversation.participants[0]?.user;
      const isDirect = conversation.type === "DIRECT";
      const isMine = row.senderId === userId;
      const deleted = row.deletedAt !== null;

      const chat = {
        id: participant.conversationId,
        type: conversation.type,
        name: isDirect
          ? (other?.name ?? "Deleted user")
          : (conversation.name ?? "Group"),
        avatar: isDirect ? (other?.avatar ?? null) : conversation.avatar,
        isOnline:
          isDirect &&
          other?.status === "ONLINE" &&
          !blockedAnyIds.has(other.id),
        otherUserId: isDirect ? (other?.id ?? null) : null,
        isBlocked: isDirect && other ? blockedByMeIds.has(other.id) : false,
        lastMessage: {
          type: row.type,
          content: deleted ? null : truncate(row.content),
          fileName: deleted ? null : row.fileName,
          senderName: isMine ? null : row.senderName,
          isMine,
          deleted,
        },
        lastMessageAt: row.createdAt,
        unreadCount: row.unreadCount,
        isMuted: Boolean(
          participant.mutedUntil && participant.mutedUntil > now,
        ),
        isPinned: participant.pinnedAt !== null,
        isArchived: participant.isArchived,
      };
      return [{ chat, pinnedAt: participant.pinnedAt }];
    });

    entries.sort((a, b) => {
      if (a.pinnedAt && b.pinnedAt) {
        return b.pinnedAt.getTime() - a.pinnedAt.getTime();
      }
      if (a.pinnedAt || b.pinnedAt) return a.pinnedAt ? -1 : 1;

      return (
        new Date(b.chat.lastMessageAt).getTime() -
        new Date(a.chat.lastMessageAt).getTime()
      );
    });

    return res
      .status(200)
      .json({ success: true, chats: entries.map((entry) => entry.chat) });
  } catch (error: any) {
    console.error("Get Conversations List Error:", error);
    return serverError(res);
  }
};

export const markConversationRead = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const { id: conversationId } = paramsResult.data;

    const changed = await markRead(conversationId, userId);

    if (!changed) {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { id: true },
      });

      if (!participant) return notFound(res, "Conversation not found.");

      return res.status(200).json({ success: true });
    }

    res.status(200).json({ success: true });

    void publishReceipts([conversationId]);
  } catch (error: any) {
    console.error("Mark Read Error:", error);
    return serverError(res);
  }
};

export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const bodyResult = sendMessageSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return validationError(res, bodyResult.error);
    }

    const { id: conversationId } = paramsResult.data;
    const input = bodyResult.data;

    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: {
        leftAt: true,
        clearedAt: true,
        conversation: { select: { type: true, directKey: true } },
      },
    });

    if (!participant) return notFound(res, "Conversation not found.");

    if (participant.leftAt) {
      return forbidden(res, "You are no longer a member of this conversation.");
    }

    const isDirect = participant.conversation.type === "DIRECT";
    const otherUserId = isDirect
      ? participant.conversation.directKey
          ?.split(":")
          .find((id) => id !== userId)
      : undefined;

    const [existing, reply, directState] = await Promise.all([
      db.message.findFirst({
        where: { senderId: userId, clientId: input.clientId },
        select: { ...messageSelect, conversationId: true },
      }),
      input.replyToId
        ? db.message.findFirst({
            where: {
              id: input.replyToId,
              conversationId,
              deletedAt: null,
              deletions: { none: { userId } },
              ...(participant.clearedAt
                ? { createdAt: { gt: participant.clearedAt } }
                : {}),
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      otherUserId
        ? Promise.all([
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
          ])
        : Promise.resolve(null),
    ]);

    if (existing) {
      if (existing.conversationId !== conversationId) {
        return conflict(res, "This client id was already used.");
      }

      return res.status(200).json({
        success: true,
        message: serializeMessage(existing, userId, participant.clearedAt),
      });
    }

    if (isDirect) {
      const [otherParticipant, block] = directState ?? [null, null];

      if (!otherParticipant || block) {
        return forbidden(res, "You can't send messages in this conversation.");
      }
    }

    if (input.replyToId && !reply) {
      return badRequest(
        res,
        "The message you're replying to is no longer available.",
      );
    }

    let media: VerifiedMedia | null = null;

    if (input.type !== "TEXT") {
      if (!isOwnPublicId(input.publicId, userId, input.type)) {
        return badRequest(res, "Invalid media reference.");
      }

      const check = await verifyChatMedia(input.type, input.publicId);

      if (!check.ok) {
        return res
          .status(check.status)
          .json({ success: false, error: check.error });
      }

      media = check.media;
    }

    const data: Prisma.MessageUncheckedCreateInput = {
      conversationId,
      senderId: userId,
      clientId: input.clientId,
      type: input.type,
      content: input.type === "VOICE" ? null : input.content || null,
      replyToId: input.replyToId ?? null,
      fileName: input.type === "FILE" ? sanitizeFileName(input.fileName) : null,
      ...(media && {
        mediaUrl: media.url,
        thumbnailUrl: media.thumbnailUrl,
        mediaMimeType: media.mimeType,
        mediaSize: media.size,
        mediaWidth: media.width,
        mediaHeight: media.height,
        mediaDuration: media.duration,
      }),
    };

    let message: MessageRow;

    try {
      message = await db.$transaction(async (tx) => {
        const created = await tx.message.create({
          data,
          select: messageSelect,
        });

        await tx.conversation.updateMany({
          where: {
            id: conversationId,
            lastMessageAt: { lt: created.createdAt },
          },
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
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;

      const winner = await db.message.findFirst({
        where: { senderId: userId, clientId: input.clientId },
        select: { ...messageSelect, conversationId: true },
      });

      if (!winner || winner.conversationId !== conversationId) {
        return conflict(res, "This client id was already used.");
      }

      return res.status(200).json({
        success: true,
        message: serializeMessage(winner, userId, participant.clearedAt),
      });
    }

    res.status(201).json({
      success: true,
      message: serializeMessage(message, userId, participant.clearedAt),
    });

    void broadcastNewMessage(message, conversationId, userId);
  } catch (error: any) {
    console.error("Send Message Error:", error);
    return serverError(res);
  }
};

export const updateChatSettings = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const bodyResult = chatSettingsSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId } = paramsResult.data;
    const { pinned, archived, mute } = bodyResult.data;

    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { id: true, pinnedAt: true },
    });

    if (!participant) return notFound(res, "Conversation not found.");

    const data: Prisma.ConversationParticipantUpdateInput = {};

    if (pinned !== undefined) {
      if (pinned && !participant.pinnedAt) {
        const pinnedCount = await db.conversationParticipant.count({
          where: { userId, pinnedAt: { not: null } },
        });

        if (pinnedCount >= MAX_PINNED_CHATS) {
          return badRequest(
            res,
            `You can pin up to ${MAX_PINNED_CHATS} chats.`,
          );
        }
      }

      data.pinnedAt = pinned ? (participant.pinnedAt ?? new Date()) : null;
    }

    if (archived !== undefined) data.isArchived = archived;

    if (mute !== undefined) {
      data.mutedUntil =
        mute === null
          ? null
          : mute === "forever"
            ? MUTE_FOREVER
            : new Date(Date.now() + MUTE_DURATIONS_MS[mute]);
    }

    const updated = await db.conversationParticipant.update({
      where: { id: participant.id },
      data,
      select: { mutedUntil: true, pinnedAt: true, isArchived: true },
    });

    const me = {
      isMuted: Boolean(updated.mutedUntil && updated.mutedUntil > new Date()),
      isPinned: updated.pinnedAt !== null,
      isArchived: updated.isArchived,
    };

    res.status(200).json({ success: true, me });

    emitToUser(userId, SOCKET_EVENTS.CONVERSATION_SETTINGS, {
      conversationId,
      me,
    });
  } catch (error: any) {
    console.error("Update Chat Settings Error:", error);
    return serverError(res);
  }
};

export const deleteChat = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const { id: conversationId } = paramsResult.data;

    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "ConversationParticipant"
      SET "clearedAt" = now(), "pinnedAt" = NULL
      WHERE "conversationId" = ${conversationId} AND "userId" = ${userId}
      RETURNING "id"
    `;

    if (rows.length === 0) return notFound(res, "Conversation not found.");

    res.status(200).json({ success: true });

    emitToUser(userId, SOCKET_EVENTS.CONVERSATION_CLEARED, { conversationId });
  } catch (error: any) {
    console.error("Delete Chat Error:", error);
    return serverError(res);
  }
};
