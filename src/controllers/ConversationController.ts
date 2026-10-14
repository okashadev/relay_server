import { Response } from "express";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  forbidden,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { newChatSchema } from "../validators/directChatValidator.js";
import { db } from "../config/db.js";
import { ConversationType, MessageType, Prisma } from "@prisma/client";
import { pairKey } from "../utils/pairKey.js";
import {
  conversationIdParamSchema,
  messagesQuerySchema,
} from "../validators/chatValidator.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";

const otherUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
  bio: true,
  status: true,
  lastSeen: true,
} satisfies Prisma.UserSelect;

const conversationSelect = (userId: string) =>
  ({
    id: true,
    type: true,
    lastMessageAt: true,
    createdAt: true,
    participants: {
      where: { userId },
      select: { mutedUntil: true, pinnedAt: true, isArchived: true },
    },
  }) satisfies Prisma.ConversationSelect;

type ConversationRow = {
  id: string;
  type: ConversationType;
  lastMessageAt: Date;
  createdAt: Date;
  participants: {
    mutedUntil: Date | null;
    pinnedAt: Date | null;
    isArchived: boolean;
  }[];
};

type OtherUser = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  bio: string | null;
  status: "ONLINE" | "OFFLINE";
  lastSeen: Date | null;
};

const toConversationResponse = (
  conversation: ConversationRow,
  otherUser: OtherUser,
) => {
  const mine = conversation.participants[0];

  return {
    id: conversation.id,
    type: conversation.type,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    otherUser,
    me: {
      isMuted: Boolean(mine?.mutedUntil && mine.mutedUntil > new Date()),
      isPinned: Boolean(mine?.pinnedAt),
      isArchived: mine?.isArchived ?? false,
    },
  };
};

const messageSenderSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
} satisfies Prisma.UserSelect;

const messageSelect = {
  id: true,
  clientId: true,
  senderId: true,
  sender: { select: messageSenderSelect },
  conversationId: true,
  type: true,
  content: true,
  mediaUrl: true,
  fileName: true,
  mediaSize: true,
  mediaWidth: true,
  mediaHeight: true,
  replyTo: {
    select: {
      id: true,
      content: true,
      createdAt: true,
      deletedAt: true,
      sender: { select: { name: true } },
    },
  },
  editedAt: true,
  deletedAt: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

const MAX_MEMBERS = 500;

const DELETED_USER: OtherUser = {
  id: "deleted",
  name: "Deleted user",
  username: "deleted",
  avatar: null,
  bio: null,
  status: "OFFLINE",
  lastSeen: null,
};

const MAX_CHATS = 100;
const PREVIEW_LENGTH = 120;
const UNREAD_CAP = 100;

const listUserSelect = {
  id: true,
  name: true,
  avatar: true,
  status: true,
} satisfies Prisma.UserSelect;

type LastMessageRow = {
  conversationId: string;
  type: MessageType;
  content: string | null;
  fileName: string | null;
  senderId: string | null;
  senderName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  unreadCount: number;
};
const truncate = (text: string | null) =>
  text ? Array.from(text).slice(0, PREVIEW_LENGTH).join("") : null;

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
      .map((message) => {
        const isDeleted = message.deletedAt !== null;
        const reply = message.replyTo;

        const hideReplyContent =
          reply !== null &&
          (reply.deletedAt !== null ||
            (clearedAt !== null && reply.createdAt <= clearedAt));

        return {
          id: message.id,
          clientId: message.senderId === userId ? message.clientId : null,
          senderId: message.senderId,
          conversationId: message.conversationId,
          sender: message.sender,
          type: message.type,
          content: isDeleted ? null : message.content,
          mediaUrl: isDeleted ? null : message.mediaUrl,
          fileName: isDeleted ? null : message.fileName,
          mediaSize: isDeleted ? null : message.mediaSize,
          mediaWidth: isDeleted ? null : message.mediaWidth,
          mediaHeight: isDeleted ? null : message.mediaHeight,
          replyTo:
            reply && !isDeleted
              ? {
                  id: reply.id,
                  content: hideReplyContent ? null : reply.content,
                  senderName: reply.sender?.name ?? null,
                }
              : null,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          createdAt: message.createdAt,
        };
      })
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

    const [conversation, mine] = await Promise.all([
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
        },
      }),
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
        },
      });
    }

    const other = conversation.participants.find(
      (participant) => participant.user.id !== userId,
    )?.user;

    let otherUser: OtherUser = other ?? DELETED_USER;

    if (other) {
      const block = await db.block.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedId: other.id },
            { blockerId: other.id, blockedId: userId },
          ],
        },
        select: { id: true },
      });

      if (block) otherUser = { ...other, status: "OFFLINE", lastSeen: null };
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
    const blockedIds = new Set(
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
          isDirect && other?.status === "ONLINE" && !blockedIds.has(other.id),
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
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id: conversationId } = paramsResult.data;
    const now = new Date();

    const updated = await db.conversationParticipant.updateMany({
      where: { conversationId, userId },
      data: { lastReadAt: now, lastDeliveredAt: now },
    });

    if (updated.count === 0) return notFound(res, "Conversation not found.");

    return res.status(200).json({ success: true, lastReadAt: now });
  } catch (error: any) {
    console.error("Mark Read Error:", error);
    return serverError(res);
  }
};
