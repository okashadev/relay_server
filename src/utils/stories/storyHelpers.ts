import { Prisma } from "@prisma/client";
import { db } from "../../config/db.js";
import { pairKey } from "../pairKey.js";

export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_STORIES = 30;
export const MAX_FEED_STORIES = 500;
export const MAX_VIEWERS = 200;
export const MAX_STORY_VIDEO_SECONDS = 60;
export const TEXT_DEDUPE_MS = 15_000;

const MAX_FRIENDS_SCAN = 1_000;

export const storyOwnerSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export const storySelect = {
  id: true,
  userId: true,
  type: true,
  mediaUrl: true,
  thumbnailUrl: true,
  mediaWidth: true,
  mediaHeight: true,
  mediaDuration: true,
  caption: true,
  backgroundColor: true,
  createdAt: true,
  expiresAt: true,
} satisfies Prisma.StorySelect;

export type StoryRow = Prisma.StoryGetPayload<{ select: typeof storySelect }>;

export const serializeStory = (
  story: StoryRow,
  extra: { viewedByMe: boolean; viewCount?: number },
) => ({
  id: story.id,
  type: story.type,
  mediaUrl: story.mediaUrl,
  thumbnailUrl: story.thumbnailUrl,
  mediaWidth: story.mediaWidth,
  mediaHeight: story.mediaHeight,
  mediaDuration: story.mediaDuration,
  caption: story.caption,
  backgroundColor: story.backgroundColor,
  createdAt: story.createdAt,
  expiresAt: story.expiresAt,
  viewedByMe: extra.viewedByMe,
  ...(extra.viewCount !== undefined && { viewCount: extra.viewCount }),
});

export const getVisibleOwnerIds = async (viewerId: string): Promise<string[]> => {
  const friendships = await db.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ senderId: viewerId }, { receiverId: viewerId }],
    },
    select: { senderId: true, receiverId: true },
    take: MAX_FRIENDS_SCAN,
  });

  const friendIds = friendships.map((friendship) =>
    friendship.senderId === viewerId
      ? friendship.receiverId
      : friendship.senderId,
  );

  if (friendIds.length === 0) return [];

  const blocks = await db.block.findMany({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: { in: friendIds } },
        { blockedId: viewerId, blockerId: { in: friendIds } },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blocked = new Set(
    blocks.map((block) =>
      block.blockerId === viewerId ? block.blockedId : block.blockerId,
    ),
  );

  return friendIds.filter((id) => !blocked.has(id));
};

export const canViewStoriesOf = async (
  viewerId: string,
  ownerId: string,
): Promise<boolean> => {
  if (viewerId === ownerId) return true;

  const [friendship, block] = await Promise.all([
    db.friendship.findUnique({
      where: { pairKey: pairKey(viewerId, ownerId) },
      select: { status: true },
    }),
    db.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: viewerId },
        ],
      },
      select: { id: true },
    }),
  ]);

  return friendship?.status === "ACCEPTED" && !block;
};