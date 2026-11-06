import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import {
  createStorySchema,
  storyIdParamSchema,
  storyReplySchema,
} from "../validators/storyValidator.js";
import { broadcastNewMessage } from "../utils/chat/messageEvents.js";
import { getOrCreateDirectConversation } from "../utils/chat/directConversation.js";
import {
  messageSelect,
  serializeMessage,
  type MessageRow,
} from "../utils/chat/messages.js";
import { persistMessage } from "../utils/chat/persistMessage.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import {
  deleteStoryMedia,
  isOwnStoryPublicId,
  verifyStoryMedia,
} from "../utils/stories/media.js";
import {
  MAX_ACTIVE_STORIES,
  MAX_FEED_STORIES,
  MAX_STORY_VIDEO_SECONDS,
  MAX_VIEWERS,
  STORY_LIFETIME_MS,
  TEXT_DEDUPE_MS,
  canViewStoriesOf,
  getVisibleOwnerIds,
  serializeStory,
  storyOwnerSelect,
  storySelect,
} from "../utils/stories/storyHelpers.js";
import { checkSendEpoch, sendE2eeError } from "../utils/e2ee/keyBundle.js";

const activeWhere = (now: Date): Prisma.StoryWhereInput => ({
  expiresAt: { gt: now },
  deletedAt: null,
});

export const createStory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = createStorySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const input = parsed.data;
    const now = new Date();

    if (input.type !== "TEXT" && !isOwnStoryPublicId(input.publicId, userId)) {
      return badRequest(res, "Invalid media reference.");
    }

    const duplicate: Prisma.StoryWhereInput =
      input.type === "TEXT"
        ? {
            type: "TEXT",
            caption: input.caption,
            backgroundColor: input.backgroundColor,
            createdAt: { gt: new Date(now.getTime() - TEXT_DEDUPE_MS) },
          }
        : { mediaUrl: { contains: input.publicId } };

    const existing = await db.story.findFirst({
      where: { userId, ...activeWhere(now), ...duplicate },
      select: storySelect,
    });

    if (existing) {
      const viewCount = await db.storyView.count({
        where: { storyId: existing.id },
      });

      return res.status(200).json({
        success: true,
        story: serializeStory(existing, { viewedByMe: true, viewCount }),
      });
    }

    const activeCount = await db.story.count({
      where: { userId, ...activeWhere(now) },
    });

    if (activeCount >= MAX_ACTIVE_STORIES) {
      return badRequest(
        res,
        `You can have up to ${MAX_ACTIVE_STORIES} active stories. Delete one to add another.`,
      );
    }

    const expiresAt = new Date(now.getTime() + STORY_LIFETIME_MS);
    let data: Prisma.StoryUncheckedCreateInput;

    if (input.type === "TEXT") {
      data = {
        userId,
        type: "TEXT",
        caption: input.caption,
        backgroundColor: input.backgroundColor,
        expiresAt,
      };
    } else {
      const check = await verifyStoryMedia(input.type, input.publicId);

      if (!check.ok) {
        return res
          .status(check.status)
          .json({ success: false, error: check.error });
      }

      const { media } = check;

      if (
        input.type === "VIDEO" &&
        media.duration !== null &&
        media.duration > MAX_STORY_VIDEO_SECONDS
      ) {
        return badRequest(
          res,
          `Videos can be up to ${MAX_STORY_VIDEO_SECONDS} seconds.`,
        );
      }

      data = {
        userId,
        type: input.type,
        mediaUrl: media.url,
        thumbnailUrl: media.thumbnailUrl,
        mediaWidth: media.width,
        mediaHeight: media.height,
        mediaDuration: media.duration,
        caption: input.caption || null,
        expiresAt,
      };
    }

    const created = await db.story.create({ data, select: storySelect });

    return res.status(201).json({
      success: true,
      story: serializeStory(created, { viewedByMe: true, viewCount: 0 }),
    });
  } catch (error: any) {
    console.error("Create Story Error:", error);
    return serverError(res);
  }
};

export const getStories = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const now = new Date();
    const friendIds = await getVisibleOwnerIds(userId);

    const [me, newestFirst] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: storyOwnerSelect }),
      db.story.findMany({
        where: { userId: { in: [userId, ...friendIds] }, ...activeWhere(now) },
        // Hadd lagne par purani nahi, nayi stories bachni chahiyein
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_FEED_STORIES,
        select: {
          ...storySelect,
          user: { select: storyOwnerSelect },
          views: { where: { viewerId: userId }, select: { viewerId: true } },
        },
      }),
    ]);

    if (!me) return unauthorized(res);

    // Har group mein purani se nayi
    const rows = newestFirst.reverse();

    // Views ki ginti sirf meri stories ki
    const myStoryIds = rows
      .filter((row) => row.userId === userId)
      .map((row) => row.id);

    const counts =
      myStoryIds.length > 0
        ? await db.storyView.groupBy({
            by: ["storyId"],
            where: { storyId: { in: myStoryIds } },
            _count: { _all: true },
          })
        : [];

    const viewCountById = new Map(
      counts.map((item) => [item.storyId, item._count._all]),
    );

    // Meri apni group hamesha pehle (khali ho tab bhi), phir dost
    const groups = new Map<
      string,
      {
        user: typeof me;
        isMine: boolean;
        stories: ReturnType<typeof serializeStory>[];
      }
    >();

    groups.set(userId, { user: me, isMine: true, stories: [] });

    for (const row of rows) {
      const isMine = row.userId === userId;
      let group = groups.get(row.userId);

      if (!group) {
        group = { user: row.user, isMine: false, stories: [] };
        groups.set(row.userId, group);
      }

      group.stories.push(
        serializeStory(row, {
          viewedByMe: isMine || row.views.length > 0,
          viewCount: isMine ? (viewCountById.get(row.id) ?? 0) : undefined,
        }),
      );
    }

    res.set("Cache-Control", "no-store");

    return res
      .status(200)
      .json({ success: true, groups: [...groups.values()] });
  } catch (error: any) {
    console.error("Get Stories Error:", error);
    return serverError(res);
  }
};

export const markStoryViewed = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = storyIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id } = paramsResult.data;

    const story = await db.story.findFirst({
      where: { id, ...activeWhere(new Date()) },
      select: { userId: true },
    });

    if (!story) return notFound(res, "Story not found.");

    // Apni story dekhne se view nahi ginta
    if (story.userId === userId) return res.status(200).json({ success: true });

    // 404: kisi ko ye bhi nahi pata chalna chahiye ke story maujood hai
    if (!(await canViewStoriesOf(userId, story.userId))) {
      return notFound(res, "Story not found.");
    }

    // Dobara dekhne par kuch nahi badalta (idempotent)
    await db.storyView.createMany({
      data: [{ storyId: id, viewerId: userId }],
      skipDuplicates: true,
    });

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("Mark Story Viewed Error:", error);
    return serverError(res);
  }
};

export const getStoryViewers = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = storyIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id } = paramsResult.data;

    // Sirf owner, aur sirf active story
    const story = await db.story.findFirst({
      where: { id, userId, ...activeWhere(new Date()) },
      select: { id: true },
    });

    if (!story) return notFound(res, "Story not found.");

    const [views, viewCount] = await Promise.all([
      db.storyView.findMany({
        where: { storyId: id },
        orderBy: [{ viewedAt: "desc" }, { viewerId: "desc" }],
        take: MAX_VIEWERS,
        select: { viewedAt: true, viewer: { select: storyOwnerSelect } },
      }),
      db.storyView.count({ where: { storyId: id } }),
    ]);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      viewers: views.map((view) => ({
        user: view.viewer,
        viewedAt: view.viewedAt,
      })),
      viewCount,
    });
  } catch (error: any) {
    console.error("Get Story Viewers Error:", error);
    return serverError(res);
  }
};

const cleanupStoryMedia = async (
  url: string,
  ownerId: string,
  storyId: string,
) => {
  try {
    const stillUsed = await db.story.count({
      where: { mediaUrl: url, id: { not: storyId }, deletedAt: null },
    });

    if (stillUsed === 0) await deleteStoryMedia(url, ownerId);
  } catch (error) {
    console.error("Story media cleanup failed:", error);
  }
};

export const deleteStory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = storyIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id } = paramsResult.data;

    const story = await db.story.findFirst({
      where: { id, userId },
      select: { id: true, mediaUrl: true, deletedAt: true },
    });

    if (!story) return notFound(res, "Story not found.");

    if (story.deletedAt) return res.status(200).json({ success: true });

    await db.story.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        mediaUrl: null,
        thumbnailUrl: null,
        caption: null,
        backgroundColor: null,
      },
    });

    res.status(200).json({ success: true });

    if (story.mediaUrl) void cleanupStoryMedia(story.mediaUrl, userId, id);
  } catch (error: any) {
    console.error("Delete Story Error:", error);
    return serverError(res);
  }
};

export const replyToStory = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = storyIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = storyReplySchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: storyId } = paramsResult.data;
    const { clientId, ciphertext, keyEpoch, keyBundle, deviceId } =
      bodyResult.data;

    const existing = await db.message.findFirst({
      where: { senderId: userId, clientId },
      select: { ...messageSelect, conversationId: true },
    });

    if (existing) {
      return res.status(200).json({
        success: true,
        conversationId: existing.conversationId,
        message: serializeMessage(existing, userId, null),
      });
    }

    const story = await db.story.findFirst({
      where: { id: storyId, ...activeWhere(new Date()) },
      select: { id: true, userId: true },
    });

    if (!story) return notFound(res, "Story not found.");

    if (story.userId === userId) {
      return badRequest(res, "You can't reply to your own story.");
    }

    if (!(await canViewStoriesOf(userId, story.userId))) {
      return notFound(res, "Story not found.");
    }

    const conversationId = await getOrCreateDirectConversation(
      userId,
      story.userId,
    );

    let message: MessageRow;

    try {
      message = await persistMessage(
        {
          conversationId,
          senderId: userId,
          clientId,
          type: "TEXT",
          ciphertext,
          keyEpoch,
          storyId: story.id,
        },
        conversationId,
        userId,
        (tx) =>
          checkSendEpoch(tx, {
            conversationId,
            actorId: userId,
            deviceId,
            keyEpoch,
            keyBundle,
          }),
      );
    } catch (error: any) {
      if (sendE2eeError(res, error)) return;
      if (error?.code !== "P2002") throw error;

      const winner = await db.message.findFirst({
        where: { senderId: userId, clientId },
        select: { ...messageSelect, conversationId: true },
      });

      if (!winner) throw error;

      return res.status(200).json({
        success: true,
        conversationId: winner.conversationId,
        message: serializeMessage(winner, userId, null),
      });
    }

    res.status(201).json({
      success: true,
      conversationId,
      message: serializeMessage(message, userId, null),
    });

    void broadcastNewMessage(message, conversationId, userId);
  } catch (error: any) {
    console.error("Reply To Story Error:", error);
    return serverError(res);
  }
};
