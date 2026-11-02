import { Prisma } from "@prisma/client";

export const mediaFrom = (userId: string) => Prisma.sql`
  FROM "Message" m
  JOIN "ConversationParticipant" cp
    ON cp."conversationId" = m."conversationId" AND cp."userId" = ${userId}
  JOIN "Conversation" c ON c."id" = m."conversationId"
  LEFT JOIN LATERAL (
    SELECT u."name"
    FROM "ConversationParticipant" p
    JOIN "User" u ON u."id" = p."userId"
    WHERE p."conversationId" = c."id" AND p."userId" <> ${userId}
    LIMIT 1
  ) other ON c."type" = 'DIRECT'`;

export const visibleMedia = (userId: string, conversationId: string | null) => {
  const parts = [
    Prisma.sql`m."type" IN ('IMAGE', 'VIDEO', 'FILE')`,
    Prisma.sql`m."deletedAt" IS NULL`,
    Prisma.sql`m."mediaUrl" IS NOT NULL`,
    Prisma.sql`(cp."clearedAt" IS NULL OR m."createdAt" > cp."clearedAt")`,
    Prisma.sql`(cp."leftAt" IS NULL OR m."createdAt" <= cp."leftAt")`,
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "MessageDeletion" d
      WHERE d."messageId" = m."id" AND d."userId" = ${userId}
    )`,
  ];

  if (conversationId) parts.push(Prisma.sql`m."conversationId" = ${conversationId}`);

  return Prisma.join(parts, " AND ");
};