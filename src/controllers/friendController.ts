import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { notificationSelect } from "../lib/notificationSelect.js";
import { emitToUser } from "../socket/socketServer.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import { Response } from "express";
import {
  requestIdParamSchema,
  searchQuerySchema,
  sendRequestSchema,
  suggestionsQuerySchema,
} from "../validators/friendValidator.js";
import {
  badRequest,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { getUserId } from "../utils/getUserId.js";
import { pairKey } from "../utils/pairKey.js";

const SEARCH_LIMIT = 15;
const MAX_FRIENDS = 500;

type Relationship = "NONE" | "REQUEST_SENT" | "REQUEST_RECEIVED" | "FRIENDS";

type PublicUser = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  bio: string | null;
};

type UserWithRelationship = PublicUser & {
  relationship: Relationship;
  friendshipId: string | null;
  isBlocked: boolean | null;
};

const publicUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
  bio: true,
} satisfies Prisma.UserSelect;

const friendUserSelect = {
  ...publicUserSelect,
  status: true,
} satisfies Prisma.UserSelect;

const notifyRelationship = (
  targetUserId: string,
  otherUserId: string,
  relationship: Relationship,
  friendshipId: string,
) =>
  emitToUser(targetUserId, SOCKET_EVENTS.FRIENDSHIP_UPDATED, {
    userId: otherUserId,
    relationship,
    friendshipId,
  });

const attachRelationships = async (
  currentUserId: string,
  users: PublicUser[],
): Promise<UserWithRelationship[]> => {
  if (users.length === 0) return [];

  const ids = users.map((user) => user.id);

  const [friendships, blocks] = await Promise.all([
    db.friendship.findMany({
      where: {
        OR: [
          { senderId: currentUserId, receiverId: { in: ids } },
          { senderId: { in: ids }, receiverId: currentUserId },
        ],
      },
      select: { id: true, senderId: true, receiverId: true, status: true },
    }),
    db.block.findMany({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: { in: ids } },
          { blockerId: { in: ids }, blockedId: currentUserId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    }),
  ]);

  const blockedByThemSet = new Set<string>();
  const blockedByMeSet = new Set<string>();

  for (const block of blocks) {
    if (block.blockerId === currentUserId) {
      blockedByMeSet.add(block.blockedId);
    } else {
      blockedByThemSet.add(block.blockerId);
    }
  }

  const byOtherUser = new Map<string, (typeof friendships)[number]>();
  for (const friendship of friendships) {
    const otherId =
      friendship.senderId === currentUserId
        ? friendship.receiverId
        : friendship.senderId;
    byOtherUser.set(otherId, friendship);
  }

  const result: UserWithRelationship[] = [];

  for (const user of users) {
    if (blockedByThemSet.has(user.id)) continue;

    const friendship = byOtherUser.get(user.id);
    const isBlocked = blockedByMeSet.has(user.id);

    if (!friendship) {
      result.push({
        ...user,
        relationship: "NONE",
        friendshipId: null,
        isBlocked,
      });
      continue;
    }

    const relationship: Relationship =
      friendship.status === "ACCEPTED"
        ? "FRIENDS"
        : friendship.senderId === currentUserId
          ? "REQUEST_SENT"
          : "REQUEST_RECEIVED";

    result.push({
      ...user,
      relationship,
      friendshipId: friendship.id,
      isBlocked,
    });
  }

  return result;
};

export const getSuggestions = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const queryResult = suggestionsQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
      return validationError(res, queryResult.error);
    }

    const { limit } = queryResult.data;

    const users = await db.$queryRaw<PublicUser[]>`
      SELECT u."id", u."name", u."username", u."avatar", u."bio"
      FROM "User" u
      WHERE u."id" <> ${userId}
        AND u."isEmailVerified" = true
        AND NOT EXISTS (
          SELECT 1
          FROM "Friendship" f
          WHERE (f."senderId" = ${userId} AND f."receiverId" = u."id")
             OR (f."receiverId" = ${userId} AND f."senderId" = u."id")
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "Block" b
          WHERE (b."blockerId" = ${userId} AND b."blockedId" = u."id")
             OR (b."blockerId" = u."id" AND b."blockedId" = ${userId})
        )
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      users: users.map((user) => ({
        ...user,
        relationship: "NONE" as const,
        friendshipId: null,
      })),
    });
  } catch (error: any) {
    console.error("Get Suggestions Error:", error);
    return serverError(res);
  }
};

export const searchUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const validationResult = searchQuerySchema.safeParse(req.query);

    if (!validationResult.success) {
      return validationError(res, validationResult.error);
    }

    const { q } = validationResult.data;

    const found = await db.user.findMany({
      where: {
        id: { not: userId },
        isEmailVerified: true,
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      },
      select: publicUserSelect,
      orderBy: { username: "asc" },
      take: SEARCH_LIMIT,
    });

    const users = await attachRelationships(userId, found);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({ success: true, users });
  } catch (error: any) {
    console.error("Search Users Error:", error);
    return serverError(res);
  }
};

export const sendFriendRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const senderId = getUserId(req);
    if (!senderId) return unauthorized(res);

    const validationResult = sendRequestSchema.safeParse(req.body);

    if (!validationResult.success)
      return validationError(res, validationResult.error);

    const { receiverId } = validationResult.data;

    if (senderId === receiverId)
      return badRequest(res, "You cannot send a friend request to yourself.");

    const [receiver, existing, isBlocked] = await Promise.all([
      db.user.findFirst({
        where: { id: receiverId, isEmailVerified: true },
        select: { id: true },
      }),
      db.friendship.findFirst({
        where: {
          OR: [
            { senderId, receiverId },
            { senderId: receiverId, receiverId: senderId },
          ],
        },
        select: { id: true, senderId: true, status: true },
      }),
      db.block.findFirst({
        where: {
          OR: [
            { blockerId: senderId, blockedId: receiverId },
            { blockerId: receiverId, blockedId: senderId },
          ],
        },
      }),
    ]);

    if (!receiver || isBlocked) {
      return notFound(res, "User not found.");
    }

    if (existing) {
      if (existing.status === "ACCEPTED") {
        return res.status(200).json({
          success: true,
          message: "You are already friends.",
          relationship: "FRIENDS",
          friendshipId: existing.id,
        });
      }

      if (existing.senderId === senderId) {
        return res.status(200).json({
          success: true,
          message: "Friend request already sent.",
          relationship: "REQUEST_SENT",
          friendshipId: existing.id,
        });
      }

      const notification = await db.$transaction(async (tx) => {
        const updated = await tx.friendship.updateMany({
          where: { id: existing.id, status: "PENDING" },
          data: { status: "ACCEPTED" },
        });

        if (updated.count === 0) return false;

        return tx.notification.create({
          data: {
            userId: receiverId,
            actorId: senderId,
            type: "FRIEND_ACCEPTED",
            friendshipId: existing.id,
          },
          select: notificationSelect,
        });
      });

      if (!notification) {
        return res.status(409).json({
          success: false,
          error: "This request just changed. Please refresh and try again.",
        });
      }

      emitToUser(receiverId, SOCKET_EVENTS.NOTIFICATION_NEW, notification);
      notifyRelationship(receiverId, senderId, "FRIENDS", existing.id);

      return res.status(200).json({
        success: true,
        message: "You are now friends.",
        relationship: "FRIENDS",
        friendshipId: existing.id,
      });
    }

    const created = await db.$transaction(async (tx) => {
      const friendship = await tx.friendship.create({
        data: {
          senderId,
          receiverId,
          pairKey: pairKey(senderId, receiverId),
        },
        select: { id: true },
      });

      const notification = await tx.notification.create({
        data: {
          userId: receiverId,
          actorId: senderId,
          type: "FRIEND_REQUEST",
          friendshipId: friendship.id,
        },
        select: notificationSelect,
      });

      return { friendship, notification };
    });

    emitToUser(
      receiverId,
      SOCKET_EVENTS.NOTIFICATION_NEW,
      created.notification,
    );
    notifyRelationship(
      receiverId,
      senderId,
      "REQUEST_RECEIVED",
      created.friendship.id,
    );

    return res.status(201).json({
      success: true,
      message: "Friend request sent.",
      relationship: "REQUEST_SENT",
      friendshipId: created.friendship.id,
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({
        success: false,
        error: "A request already exists. Please refresh and try again.",
      });
    }

    console.error("Send Friend Request Error:", error);
    return serverError(res);
  }
};

export const cancelFriendRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = requestIdParamSchema.safeParse(req.params);

    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const { id } = paramsResult.data;

    const pending = await db.friendship.findFirst({
      where: { id, senderId: userId, status: "PENDING" },
      select: { receiverId: true },
    });

    const deleted = await db.friendship.deleteMany({
      where: { id, senderId: userId, status: "PENDING" },
    });

    if (deleted.count > 0) {
      if (pending) {
        notifyRelationship(pending.receiverId, userId, "NONE", id);
      }

      return res.status(200).json({
        success: true,
        message: "Friend request cancelled.",
        relationship: "NONE" as const,
        friendshipId: null,
      });
    }

    const current = await db.friendship.findFirst({
      where: { id, senderId: userId },
      select: { id: true, status: true },
    });

    if (current?.status === "ACCEPTED") {
      return res.status(200).json({
        success: true,
        message: "They already accepted your request.",
        relationship: "FRIENDS" as const,
        friendshipId: current.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Friend request already cancelled.",
      relationship: "NONE" as const,
      friendshipId: null,
    });
  } catch (error: any) {
    console.error("Cancel Friend Request Error:", error);
    return serverError(res);
  }
};

export const acceptFriendRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = requestIdParamSchema.safeParse(req.params);

    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const { id } = paramsResult.data;

    const friendship = await db.friendship.findFirst({
      where: { id, receiverId: userId },
      select: { id: true, senderId: true, status: true },
    });

    if (!friendship) {
      return notFound(res, "Friend request not found.");
    }

    if (friendship.status === "ACCEPTED") {
      return res.status(200).json({
        success: true,
        message: "You are already friends.",
        relationship: "FRIENDS" as const,
        friendshipId: friendship.id,
      });
    }

    const notification = await db.$transaction(async (tx) => {
      const updated = await tx.friendship.updateMany({
        where: { id, receiverId: userId, status: "PENDING" },
        data: { status: "ACCEPTED" },
      });

      if (updated.count === 0) return null;

      const created = await tx.notification.create({
        data: {
          userId: friendship.senderId,
          actorId: userId,
          type: "FRIEND_ACCEPTED",
          friendshipId: id,
        },
        select: notificationSelect,
      });

      await tx.notification.updateMany({
        where: { userId, friendshipId: id, type: "FRIEND_REQUEST" },
        data: { isRead: true },
      });

      return created;
    });

    if (!notification) {
      const current = await db.friendship.findFirst({
        where: { id, receiverId: userId },
        select: { id: true, status: true },
      });

      if (current?.status === "ACCEPTED") {
        return res.status(200).json({
          success: true,
          message: "You are already friends.",
          relationship: "FRIENDS" as const,
          friendshipId: current.id,
        });
      }

      return notFound(res, "Friend request not found.");
    }

    emitToUser(
      friendship.senderId,
      SOCKET_EVENTS.NOTIFICATION_NEW,
      notification,
    );
    notifyRelationship(friendship.senderId, userId, "FRIENDS", id);

    return res.status(200).json({
      success: true,
      message: "Friend request accepted.",
      relationship: "FRIENDS" as const,
      friendshipId: id,
    });
  } catch (error: any) {
    console.error("Accept Friend Request Error:", error);
    return serverError(res);
  }
};

export const rejectFriendRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = requestIdParamSchema.safeParse(req.params);

    if (!paramsResult.success) {
      return validationError(res, paramsResult.error);
    }

    const { id } = paramsResult.data;

    const deleted = await db.friendship.deleteMany({
      where: { id, receiverId: userId, status: "PENDING" },
    });

    if (deleted.count > 0) {
      return res.status(200).json({
        success: true,
        message: "Friend request rejected.",
        relationship: "NONE" as const,
        friendshipId: null,
      });
    }

    const current = await db.friendship.findFirst({
      where: { id, receiverId: userId },
      select: { id: true, status: true },
    });

    if (current?.status === "ACCEPTED") {
      return res.status(200).json({
        success: true,
        message: "You are already friends.",
        relationship: "FRIENDS" as const,
        friendshipId: current.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Friend request already removed.",
      relationship: "NONE" as const,
      friendshipId: null,
    });
  } catch (error: any) {
    console.error("Reject Friend Request Error:", error);
    return serverError(res);
  }
};

export const getFriends = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const friendsList = await db.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
      select: {
        id: true,
        senderId: true,
        sender: { select: friendUserSelect },
        receiver: { select: friendUserSelect },
      },
      take: MAX_FRIENDS,
    });

    const friends = friendsList
      .map((list) => {
        const other = list.senderId === userId ? list.receiver : list.sender;

        return { ...other, friendshipId: list.id };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );

    res.set("Cache-Control", "no-store");

    return res.status(200).json({ success: true, friends });
  } catch (error: any) {
    console.error("Get Friends Error:", error);
    return serverError(res);
  }
};
