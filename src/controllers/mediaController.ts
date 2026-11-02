import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { mediaFrom, visibleMedia } from "../utils/media/mediaQueries.js";
import { mediaQuerySchema } from "../validators/mediaValidator.js";

type ChatType = "DIRECT" | "GROUP";

type MediaRow = {
  id: string;
  conversationId: string;
  senderId: string | null;
  type: "IMAGE" | "VIDEO" | "FILE";
  mediaUrl: string;
  thumbnailUrl: string | null;
  mediaMimeType: string | null;
  fileName: string | null;
  mediaSize: number | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  mediaDuration: number | null;
  createdAt: Date;
  conversationType: ChatType;
  groupName: string | null;
  otherName: string | null;
  senderName: string | null;
  senderAvatar: string | null;
};

type SummaryRow = {
  id: string;
  type: ChatType;
  groupName: string | null;
  otherName: string | null;
  visual: number;
  files: number;
  bytes: number;
};

const chatName = (type: ChatType, groupName: string | null, otherName: string | null) =>
  type === "DIRECT" ? (otherName ?? "Deleted user") : (groupName ?? "Group");

export const getMedia = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = mediaQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);

    const { kind, conversationId, cursor, limit } = parsed.data;

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) return badRequest(res, "Invalid cursor.");

    const kindSql =
      kind === "files"
        ? Prisma.sql`m."type" = 'FILE'`
        : Prisma.sql`m."type" IN ('IMAGE', 'VIDEO')`;

    const cursorSql = decoded
      ? Prisma.sql`AND (m."createdAt" < ${decoded.createdAt.toISOString()}::timestamp
          OR (m."createdAt" = ${decoded.createdAt.toISOString()}::timestamp AND m."id" < ${decoded.id}))`
      : Prisma.empty;

    const rows = await db.$queryRaw<MediaRow[]>`
      SELECT
        m."id", m."conversationId", m."senderId", m."type",
        m."mediaUrl", m."thumbnailUrl", m."mediaMimeType", m."fileName",
        m."mediaSize"::int AS "mediaSize",
        m."mediaWidth"::int AS "mediaWidth",
        m."mediaHeight"::int AS "mediaHeight",
        m."mediaDuration"::int AS "mediaDuration",
        m."createdAt",
        c."type" AS "conversationType",
        c."name" AS "groupName",
        other."name" AS "otherName",
        s."name" AS "senderName",
        s."avatar" AS "senderAvatar"
      ${mediaFrom(userId)}
      LEFT JOIN "User" s ON s."id" = m."senderId"
      WHERE ${visibleMedia(userId, conversationId ?? null)} AND ${kindSql} ${cursorSql}
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page[page.length - 1];

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      items: page.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        conversationType: row.conversationType,
        conversationName: chatName(row.conversationType, row.groupName, row.otherName),
        senderId: row.senderId ?? "",
        senderName: row.senderName ?? "Deleted user",
        senderAvatar: row.senderAvatar,
        type: row.type,
        mediaUrl: row.mediaUrl,
        thumbnailUrl: row.thumbnailUrl,
        mediaMimeType: row.mediaMimeType ?? "",
        fileName: row.fileName,
        mediaSize: row.mediaSize ?? 0,
        mediaWidth: row.mediaWidth,
        mediaHeight: row.mediaHeight,
        mediaDuration: row.mediaDuration,
        createdAt: row.createdAt,
      })),
      nextCursor: hasMore && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
    });
  } catch (error: any) {
    console.error("Get Media Error:", error);
    return serverError(res);
  }
};

export const getMediaSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const rows = await db.$queryRaw<SummaryRow[]>`
      SELECT
        m."conversationId" AS "id",
        c."type" AS "type",
        c."name" AS "groupName",
        other."name" AS "otherName",
        count(*) FILTER (WHERE m."type" IN ('IMAGE', 'VIDEO'))::int AS "visual",
        count(*) FILTER (WHERE m."type" = 'FILE')::int AS "files",
        COALESCE(sum(m."mediaSize"), 0)::float8 AS "bytes"
      ${mediaFrom(userId)}
      WHERE ${visibleMedia(userId, null)}
      GROUP BY m."conversationId", c."type", c."name", other."name"
      LIMIT 500
    `;

    const chats = rows
      .map((row) => ({
        id: row.id,
        type: row.type,
        name: chatName(row.type, row.groupName, row.otherName),
        visual: row.visual,
        files: row.files,
        bytes: row.bytes,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true, chats });
  } catch (error: any) {
    console.error("Get Media Summary Error:", error);
    return serverError(res);
  }
};