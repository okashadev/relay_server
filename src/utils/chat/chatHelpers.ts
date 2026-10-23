import { Response } from "express";
import {
  ConversationRow,
  LastMessageRow,
  OtherUser,
} from "../../types/conversationTypes.js";
import { ChatAccess } from "./chatAccess.js";
import {
  listUserSelect,
  MAX_CHATS,
  PREVIEW_LENGTH,
  UNREAD_CAP,
} from "./chatConstants.js";
import { Prisma } from "@prisma/client";
import { db } from "../../config/db.js";

export const truncate = (text: string | null) =>
  text ? Array.from(text).slice(0, PREVIEW_LENGTH).join("") : null;

export const toConversationResponse = (
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

export const denyAccess = (
  res: Response,
  access: Extract<ChatAccess, { ok: false }>,
) => res.status(access.status).json({ success: false, error: access.error });

type UnreadCountRow = {
  conversationId: string;
  unreadCount: number;
};

const getUnreadCounts = async (
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> => {
  if (conversationIds.length === 0) {
    return new Map();
  }

  const rows = await db.$queryRaw<UnreadCountRow[]>`
    SELECT
      cp."conversationId",
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT 1
          FROM "Message" m
          WHERE m."conversationId" = cp."conversationId"
            AND m."senderId" IS DISTINCT FROM cp."userId"
            AND m."type" <> 'SYSTEM'
            AND m."deletedAt" IS NULL
            AND (
              cp."lastReadAt" IS NULL
              OR m."createdAt" > cp."lastReadAt"
            )
            AND (
              cp."clearedAt" IS NULL
              OR m."createdAt" > cp."clearedAt"
            )
            AND (
              cp."leftAt" IS NULL
              OR m."createdAt" <= cp."leftAt"
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "MessageDeletion" d
              WHERE d."messageId" = m."id"
                AND d."userId" = cp."userId"
            )
          LIMIT ${UNREAD_CAP}
        ) capped
      ) AS "unreadCount"
    FROM "ConversationParticipant" cp
    WHERE cp."userId" = ${userId}
      AND cp."conversationId" IN (${Prisma.join(conversationIds)})
  `;

  return new Map(rows.map((row) => [row.conversationId, row.unreadCount]));
};

export const buildChatList = async (userId: string, q: string | null) => {
  const search: Prisma.ConversationParticipantWhereInput = q
    ? {
        conversation: {
          OR: [
            { type: "GROUP", name: { contains: q, mode: "insensitive" } },
            {
              type: "DIRECT",
              participants: {
                some: {
                  userId: { not: userId },
                  user: {
                    OR: [
                      { name: { contains: q, mode: "insensitive" } },
                      { username: { contains: q, mode: "insensitive" } },
                    ],
                  },
                },
              },
            },
          ],
        },
      }
    : {};

  const participants = await db.conversationParticipant.findMany({
    where: { userId, ...search },
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
          lastMessageAt: true,
          participants: {
            where: { userId: { not: userId } },
            take: 1,
            select: { user: { select: listUserSelect } },
          },
        },
      },
    },
  });

  if (participants.length === 0) return [];

  const conversationIds = participants.map((p) => p.conversationId);
  const otherUserIds = participants.flatMap((p) => {
    const other = p.conversation.participants[0]?.user;
    return p.conversation.type === "DIRECT" && other ? [other.id] : [];
  });

  const [rows, blocks, unreadCounts] = await Promise.all([
    db.$queryRaw<LastMessageRow[]>`
      SELECT
        cp."conversationId",
        lm."type",
        lm."content",
        lm."fileName",
        lm."senderId",
        lm."deletedAt",
        lm."createdAt",
        sender."name" AS "senderName"
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
    getUnreadCounts(userId, conversationIds),
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

    if (!row && q === null) return [];

    const { conversation } = participant;
    const other = conversation.participants[0]?.user;
    const isDirect = conversation.type === "DIRECT";
    const isMine = row?.senderId === userId;
    const deleted = row ? row.deletedAt !== null : false;

    const chat = {
      id: participant.conversationId,
      type: conversation.type,
      name: isDirect
        ? (other?.name ?? "Deleted user")
        : (conversation.name ?? "Group"),
      avatar: isDirect ? (other?.avatar ?? null) : conversation.avatar,
      isOnline:
        isDirect && other?.status === "ONLINE" && !blockedAnyIds.has(other.id),
      otherUserId: isDirect ? (other?.id ?? null) : null,
      isBlocked: isDirect && other ? blockedByMeIds.has(other.id) : false,
      lastMessage: row
        ? {
            type: row.type,
            content: deleted ? null : truncate(row.content),
            fileName: deleted ? null : row.fileName,
            senderName: isMine ? null : row.senderName,
            isMine,
            deleted,
          }
        : null,
      lastMessageAt: row?.createdAt ?? conversation.lastMessageAt,
      unreadCount: unreadCounts.get(participant.conversationId) ?? 0,
      isMuted: Boolean(participant.mutedUntil && participant.mutedUntil > now),
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

  return entries.map((entry) => entry.chat);
};
