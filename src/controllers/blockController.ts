import { Prisma } from "@prisma/client";
import { Response } from "express";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { db } from "../config/db.js";
import { blockBodySchema, blockParamsSchema } from "../validators/chatValidator.js";
import { pairKey } from "../utils/pairKey.js";
import { emitToUser } from "../socket/socketServer.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { hidePresenceBetween, revealPresenceBetween } from "../utils/presence.js";

const blockedUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export const getBlockedUsers = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const rows = await db.block.findMany({
      where: { blockedId: userId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { createdAt: true, blocked: { select: blockedUserSelect } },
    });

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      users: rows.map((row) => ({ ...row.blocked, blockedAt: row.createdAt })),
    });
  } catch (error: any) {
    console.error("Get Blocked Users Error:", error);
    return serverError(res);
  }
};

export const blockUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const bodyResult = blockBodySchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const targetId = bodyResult.data.userId;

    if (targetId === userId) {
      return badRequest(res, "You can't block yourself.");
    }

    const target = await db.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });

    if (!target) return notFound(res, "User not found.");

    const removedFriendshipId = await db.$transaction(async (tx) => {
      await tx.block.createMany({
        data: [{ blockerId: userId, blockedId: targetId }],
        skipDuplicates: true,
      });

      const friendship = await tx.friendship.findUnique({
        where: { pairKey: pairKey(userId, targetId) },
        select: { id: true },
      });

      if (!friendship) return null;

      await tx.friendship.deleteMany({ where: { id: friendship.id } });
      return friendship.id;
    });

    res.status(200).json({ success: true });

    emitToUser(userId, SOCKET_EVENTS.BLOCK_UPDATED, {
      userId: targetId,
      blocked: true,
    });

    if (removedFriendshipId) {
      emitToUser(userId, SOCKET_EVENTS.FRIENDSHIP_UPDATED, {
        userId: targetId,
        relationship: "NONE",
        friendshipId: removedFriendshipId,
      });
      emitToUser(targetId, SOCKET_EVENTS.FRIENDSHIP_UPDATED, {
        userId,
        relationship: "NONE",
        friendshipId: removedFriendshipId,
      });
    }

    hidePresenceBetween(userId, targetId);
  } catch (error: any) {
    console.error("Block User Error:", error);
    return serverError(res);
  }
};

export const unblockUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = blockParamsSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const targetId = paramsResult.data.userId;

    await db.block.deleteMany({
      where: { blockerId: userId, blockedId: targetId },
    });

    res.status(200).json({ success: true });

    emitToUser(userId, SOCKET_EVENTS.BLOCK_UPDATED, {
      userId: targetId,
      blocked: false,
    });

    void revealPresenceBetween(userId, targetId);
  } catch (error: any) {
    console.error("Unblock User Error:", error);
    return serverError(res);
  }
};
