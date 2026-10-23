import { Response } from "express";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import {
  badRequest,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { getUserId } from "../utils/getUserId.js";
import { createGroupSchema } from "../validators/groupValidator.js";
import { db } from "../config/db.js";
import { emitToUser } from "../socket/socketServer.js";
import { SOCKET_EVENTS } from "../socket/events.js";

export const createGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const ValidationResult = createGroupSchema.safeParse(req.body);
    if (!ValidationResult.success)
      return validationError(res, ValidationResult.error);

    const { name, description, memberIds } = ValidationResult.data;

    if (memberIds.length < 2) {
      return badRequest(res, "Please select at least 2 people");
    }

    const [members, blocks] = await Promise.all([
      db.user.findMany({
        where: {
          id: { in: memberIds },
          isEmailVerified: true,
        },
        select: {
          id: true,
          name: true,
        },
      }),
      db.block.findMany({
        where: {
          OR: [
            { blockerId: userId, blockedId: { in: memberIds } },
            { blockedId: userId, blockerId: { in: memberIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
    ]);

    if (members.length !== memberIds.length) {
      return badRequest(res, "Some selected users are invalid or not found.");
    }

    const blockedIds = new Set(
      blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)),
    );

    const hasBlockedUser = members.some((m) => blockedIds.has(m.id));
    if (hasBlockedUser) {
      return badRequest(res, "You cannot add a blocked user to the group.");
    }

    const result = await db.$transaction(async (tx) => {
      const newConversation = await tx.conversation.create({
        data: {
          type: "GROUP",
          name,
          description,
          createdById: userId,
        },
        select: {
          id: true,
          name: true,
          type: true,
          avatar: true,
          createdBy: { select: { id: true, name: true } },
          description: true,
          participants: true,
        },
      });

      await tx.conversationParticipant.createMany({
        data: [
          {
            conversationId: newConversation.id,
            userId: userId,
            role: "ADMIN" as const,
          },
          ...members.map((member) => ({
            conversationId: newConversation.id,
            userId: member.id,
            role: "MEMBER" as const,
          })),
        ],
      });

      await tx.notification.createMany({
        data: members.map((member) => ({
          userId: member.id,
          actorId: userId,
          type: "GROUP_ADDED",
          conversationId: newConversation.id,
        })),
      });

      const notifications = await tx.notification.findMany({
        where: {
          conversationId: newConversation.id,
          type: "GROUP_ADDED",
          userId: { in: members.map((member) => member.id) },
        },
        select: {
          id: true,
          userId: true,
          actorId: true,
          type: true,
          conversationId: true,
          isRead: true,
          createdAt: true,
          actor: {
            select: {
              id: true,
              name: true,
              avatar: true,
            },
          },
          conversation: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return { newConversation, notifications };
    });

    for (const notification of result.notifications) {
      emitToUser(
        notification.userId,
        SOCKET_EVENTS.NOTIFICATION_NEW,
        notification,
      );
    }

    res.set("Cache-Control", "no-store");

    return res.status(201).json({
      success: true,
      conversation: result.newConversation,
    });
  } catch (error: any) {
    console.log("Create Group Error: ", error);
    return serverError(res);
  }
};
