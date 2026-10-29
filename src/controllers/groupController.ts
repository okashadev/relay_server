import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { notificationSelect } from "../lib/notificationSelect.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { emitToUser, emitToUsers } from "../socket/socketServer.js";
import { getUserId } from "../utils/getUserId.js";
import { otherUserSelect } from "../utils/chat/chatConstants.js";
import { broadcastNewMessage } from "../utils/chat/messageEvents.js";
import type { MessageRow } from "../utils/chat/messages.js";
import { createSystemMessage } from "../utils/chat/systemMessages.js";
import {
  MAX_AVATAR_BYTES,
  avatarFormatFromMime,
  buildAvatarUpload,
  deleteGroupAvatar,
  isGroupAvatarPublicId,
  newGroupAvatarPublicId,
  verifyGroupAvatar,
} from "../utils/group/groupAvatar.js";
import { MAX_GROUP_MEMBERS } from "../utils/group/groupConstants.js";
import {
  getGroupActor,
  getInvitableIds,
  isAdminRole,
  joinNames,
  latestMessageAt,
  nameMap,
  type GroupAccess,
} from "../utils/group/groupHelpers.js";
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
  addMembersSchema,
  createGroupSchema,
  groupIdParamSchema,
  groupMemberParamSchema,
  memberRoleSchema,
  signAvatarSchema,
  updateGroupSchema,
} from "../validators/groupValidator.js";

const deny = (res: Response, access: Extract<GroupAccess, { ok: false }>) =>
  res.status(access.status).json({ success: false, error: access.error });

const notifyMembers = async (
  conversationId: string,
  extraUserIds: string[] = [],
) => {
  try {
    const members = await db.conversationParticipant.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true },
    });

    emitToUsers(
      [...new Set([...members.map((m) => m.userId), ...extraUserIds])],
      SOCKET_EVENTS.GROUP_UPDATED,
      { conversationId },
    );
  } catch (error) {
    console.error("Group update broadcast failed:", error);
  }
};

const publishNotifications = (notifications: { userId: string }[]) => {
  for (const notification of notifications) {
    emitToUser(
      notification.userId,
      SOCKET_EVENTS.NOTIFICATION_NEW,
      notification,
    );
  }
};

const createGroupNotifications = async (
  tx: Prisma.TransactionClient,
  conversationId: string,
  actorId: string,
  userIds: string[],
) => {
  const startedAt = new Date();

  await tx.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      actorId,
      type: "GROUP_ADDED" as const,
      conversationId,
    })),
  });

  return tx.notification.findMany({
    where: {
      conversationId,
      type: "GROUP_ADDED",
      userId: { in: userIds },
      createdAt: { gte: startedAt },
    },
    select: { ...notificationSelect, userId: true },
  });
};

const conflictOrServerError = (res: Response, error: any, label: string) => {
  if (error?.message === "GROUP_CONFLICT" || error?.code === "P2002") {
    return conflict(
      res,
      "This group just changed. Please refresh and try again.",
    );
  }

  console.error(`${label}:`, error);
  return serverError(res);
};

export const createGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { name, description } = parsed.data;

    const memberIds = [...new Set(parsed.data.memberIds)].filter(
      (id) => id !== userId,
    );

    if (memberIds.length < 2) {
      return badRequest(res, "Please select at least 2 people.");
    }

    const invitable = await getInvitableIds(userId, memberIds);

    if (invitable.length !== memberIds.length) {
      return badRequest(res, "You can only add your friends to a group.");
    }

    const result = await db.$transaction(async (tx) => {
      const group = await tx.conversation.create({
        data: {
          type: "GROUP",
          name,
          description: description || null,
          createdById: userId,
          participants: {
            create: [
              { userId, role: "OWNER" as const },
              ...memberIds.map((id) => ({
                userId: id,
                role: "MEMBER" as const,
              })),
            ],
          },
        },
        select: { id: true, name: true },
      });

      const names = await nameMap(tx, [userId]);

      // Chat list sirf wohi chat dikhati hai jis mein message ho, isliye ye zaroori hai
      const message = await createSystemMessage(tx, {
        conversationId: group.id,
        actorId: userId,
        content: `${names.get(userId) ?? "Someone"} created the group "${name}"`,
        metadata: { action: "GROUP_CREATED" },
      });

      const notifications = await createGroupNotifications(
        tx,
        group.id,
        userId,
        memberIds,
      );

      return { group, message, notifications };
    });

    res.set("Cache-Control", "no-store");
    res.status(201).json({ success: true, conversation: result.group });

    void broadcastNewMessage(result.message, result.group.id, userId);
    publishNotifications(result.notifications);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Create Group Error");
  }
};

export const addMembers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = addMembersSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId } = paramsResult.data;
    const memberIds = [...new Set(bodyResult.data.memberIds)].filter(
      (id) => id !== userId,
    );

    if (memberIds.length === 0) {
      return badRequest(res, "Select at least one friend to add.");
    }

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    if (!isAdminRole(access.role)) {
      return forbidden(res, "Only admins can add members.");
    }

    const invitable = await getInvitableIds(userId, memberIds);

    if (invitable.length !== memberIds.length) {
      return badRequest(res, "You can only add your friends to a group.");
    }

    const result = await db.$transaction(async (tx) => {
      const existing = await tx.conversationParticipant.findMany({
        where: { conversationId, userId: { in: memberIds } },
        select: { userId: true, leftAt: true },
      });

      const activeIds = new Set(
        existing.filter((p) => p.leftAt === null).map((p) => p.userId),
      );
      const toAdd = memberIds.filter((id) => !activeIds.has(id));

      if (toAdd.length === 0) return { error: "ALREADY_MEMBERS" as const };

      const activeCount = await tx.conversationParticipant.count({
        where: { conversationId, leftAt: null },
      });

      if (activeCount + toAdd.length > MAX_GROUP_MEMBERS) {
        return { error: "FULL" as const };
      }

      // Naye (ya wapas aaye) member purani history nahi dekhte, aur unka unread aur ticks us waqt se
      const lastAt = await latestMessageAt(tx, conversationId);
      const history = {
        clearedAt: lastAt,
        lastReadAt: lastAt,
        lastDeliveredAt: lastAt,
      };

      const returningIds = new Set(existing.map((p) => p.userId));
      const newIds = toAdd.filter((id) => !returningIds.has(id));
      const rejoinIds = toAdd.filter((id) => returningIds.has(id));

      if (newIds.length > 0) {
        await tx.conversationParticipant.createMany({
          data: newIds.map((id) => ({
            conversationId,
            userId: id,
            role: "MEMBER" as const,
            ...history,
          })),
        });
      }

      if (rejoinIds.length > 0) {
        await tx.conversationParticipant.updateMany({
          where: { conversationId, userId: { in: rejoinIds } },
          data: {
            leftAt: null,
            role: "MEMBER",
            joinedAt: new Date(),
            pinnedAt: null,
            isArchived: false,
            ...history,
          },
        });
      }

      const names = await nameMap(tx, [userId, ...toAdd]);

      const message = await createSystemMessage(tx, {
        conversationId,
        actorId: userId,
        content: `${names.get(userId) ?? "Someone"} added ${joinNames(
          toAdd.map((id) => names.get(id) ?? "someone"),
        )}`,
        metadata: { action: "MEMBERS_ADDED", targetIds: toAdd },
      });

      const notifications = await createGroupNotifications(
        tx,
        conversationId,
        userId,
        toAdd,
      );

      const members = await tx.conversationParticipant.findMany({
        where: { conversationId, userId: { in: toAdd } },
        select: { role: true, user: { select: otherUserSelect } },
      });

      return { error: null, message, notifications, members };
    });

    if (result.error === "ALREADY_MEMBERS") {
      return badRequest(res, "These people are already in the group.");
    }
    if (result.error === "FULL") {
      return badRequest(
        res,
        `A group can have up to ${MAX_GROUP_MEMBERS} members.`,
      );
    }

    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, members: result.members });

    void broadcastNewMessage(result.message, conversationId, userId);
    publishNotifications(result.notifications);
    void notifyMembers(conversationId);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Add Members Error");
  }
};

export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupMemberParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id: conversationId, memberId } = paramsResult.data;

    if (memberId === userId) {
      return badRequest(
        res,
        "You can't remove yourself. Use Leave group instead.",
      );
    }

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    if (!isAdminRole(access.role)) {
      return forbidden(res, "Only admins can remove members.");
    }

    const result = await db.$transaction(async (tx) => {
      const target = await tx.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId: memberId } },
        select: { role: true, leftAt: true },
      });

      if (!target || target.leftAt) return { error: "NOT_MEMBER" as const };

      if (target.role !== "MEMBER" && access.role !== "OWNER") {
        return { error: "FORBIDDEN" as const };
      }

      const names = await nameMap(tx, [userId, memberId]);

      const message = await createSystemMessage(tx, {
        conversationId,
        actorId: userId,
        content: `${names.get(userId) ?? "Someone"} removed ${
          names.get(memberId) ?? "a member"
        }`,
        metadata: { action: "MEMBER_REMOVED", targetId: memberId },
      });

      const removed = await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: memberId, leftAt: null },
        data: {
          leftAt: new Date(),
          role: "MEMBER",
          pinnedAt: null,
          isArchived: false,
        },
      });

      if (removed.count === 0) throw new Error("GROUP_CONFLICT");

      return { error: null, message };
    });

    if (result.error === "NOT_MEMBER") {
      return badRequest(res, "This user is not an active group member.");
    }
    if (result.error === "FORBIDDEN") {
      return forbidden(res, "Only the owner can remove an admin.");
    }

    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true });

    void broadcastNewMessage(result.message, conversationId, userId);
    void notifyMembers(conversationId, [memberId]);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Remove Member Error");
  }
};

export const leaveGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id: conversationId } = paramsResult.data;

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    const result = await db.$transaction(async (tx) => {
      if (access.role === "OWNER") {
        const next = await tx.conversationParticipant.findFirst({
          where: { conversationId, leftAt: null, userId: { not: userId } },
          orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
          select: { id: true },
        });

        if (next) {
          await tx.conversationParticipant.update({
            where: { id: next.id },
            data: { role: "OWNER" },
          });
        }
      }

      const names = await nameMap(tx, [userId]);

      const message = await createSystemMessage(tx, {
        conversationId,
        actorId: userId,
        content: `${names.get(userId) ?? "Someone"} left`,
        metadata: { action: "MEMBER_LEFT" },
      });

      const left = await tx.conversationParticipant.updateMany({
        where: { conversationId, userId, leftAt: null },
        data: {
          leftAt: new Date(),
          role: "MEMBER",
          pinnedAt: null,
          isArchived: false,
        },
      });

      if (left.count === 0) throw new Error("GROUP_CONFLICT");

      return { message };
    });

    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true });

    void broadcastNewMessage(result.message, conversationId, userId);
    void notifyMembers(conversationId, [userId]);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Leave Group Error");
  }
};

export const setMemberRole = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupMemberParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = memberRoleSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId, memberId } = paramsResult.data;
    const { role } = bodyResult.data;

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    if (access.role !== "OWNER") {
      return forbidden(res, "Only the group owner can change roles.");
    }

    if (memberId === userId) {
      return badRequest(res, "You can't change your own role.");
    }

    const target = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: memberId } },
      select: { id: true, role: true, leftAt: true },
    });

    if (!target || target.leftAt) {
      return badRequest(res, "This user is not an active group member.");
    }

    if (target.role === "OWNER") {
      return forbidden(res, "The owner's role can't be changed.");
    }

    if (target.role === role)
      return res.status(200).json({ success: true, role });

    const message = await db.$transaction(async (tx) => {
      await tx.conversationParticipant.update({
        where: { id: target.id },
        data: { role },
      });

      const names = await nameMap(tx, [userId, memberId]);
      const actor = names.get(userId) ?? "Someone";
      const member = names.get(memberId) ?? "a member";

      return createSystemMessage(tx, {
        conversationId,
        actorId: userId,
        content:
          role === "ADMIN"
            ? `${actor} made ${member} a group admin`
            : `${actor} removed ${member} as admin`,
        metadata: { action: "ROLE_CHANGED", targetId: memberId, role },
      });
    });

    res.status(200).json({ success: true, role });

    void broadcastNewMessage(message, conversationId, userId);
    void notifyMembers(conversationId);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Set Member Role Error");
  }
};

export const signGroupAvatarUpload = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = signAvatarSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId } = paramsResult.data;
    const { mimeType, size } = bodyResult.data;

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    if (!isAdminRole(access.role)) {
      return forbidden(res, "Only admins can change the group photo.");
    }

    if (!avatarFormatFromMime(mimeType)) {
      return badRequest(res, "Use a JPG, PNG or WebP image.");
    }

    if (size > MAX_AVATAR_BYTES) {
      return badRequest(res, "Image is too large. Maximum size is 5 MB.");
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      upload: buildAvatarUpload(newGroupAvatarPublicId(conversationId)),
    });
  } catch (error: any) {
    console.error("Sign Group Avatar Error:", error);
    return serverError(res);
  }
};

export const updateGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = groupIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const bodyResult = updateGroupSchema.safeParse(req.body);
    if (!bodyResult.success) return validationError(res, bodyResult.error);

    const { id: conversationId } = paramsResult.data;
    const { name, description, avatarPublicId, removeAvatar } = bodyResult.data;

    if (avatarPublicId && removeAvatar) {
      return badRequest(res, "Choose either a new photo or remove it.");
    }

    const access = await getGroupActor(db, conversationId, userId);
    if (!access.ok) return deny(res, access);

    if (!isAdminRole(access.role)) {
      return forbidden(res, "Only admins can edit group info.");
    }

    let avatarUrl: string | undefined;

    if (avatarPublicId) {
      if (!isGroupAvatarPublicId(avatarPublicId, conversationId)) {
        return badRequest(res, "Invalid image reference.");
      }

      const check = await verifyGroupAvatar(avatarPublicId);

      if (!check.ok) {
        return res
          .status(check.status)
          .json({ success: false, error: check.error });
      }

      avatarUrl = check.url;
    }

    const [current, actor] = await Promise.all([
      db.conversation.findUnique({
        where: { id: conversationId },
        select: { name: true, description: true, avatar: true },
      }),
      db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);

    if (!current) return notFound(res, "Group not found.");

    const actorName = actor?.name ?? "Someone";
    const data: Prisma.ConversationUpdateInput = {};
    const notes: { action: string; content: string }[] = [];

    if (name !== undefined && name !== current.name) {
      data.name = name;
      notes.push({
        action: "GROUP_RENAMED",
        content: `${actorName} changed the group name to "${name}"`,
      });
    }

    const nextDescription =
      description === undefined ? undefined : description || null;

    if (
      nextDescription !== undefined &&
      nextDescription !== current.description
    ) {
      data.description = nextDescription;
      notes.push({
        action: "GROUP_DESCRIPTION_CHANGED",
        content: `${actorName} changed the group description`,
      });
    }

    let replacedAvatar: string | null = null;

    if (avatarUrl !== undefined) {
      data.avatar = avatarUrl;
      replacedAvatar = current.avatar;
      notes.push({
        action: "GROUP_AVATAR_CHANGED",
        content: `${actorName} changed the group icon`,
      });
    } else if (removeAvatar && current.avatar) {
      data.avatar = null;
      replacedAvatar = current.avatar;
      notes.push({
        action: "GROUP_AVATAR_REMOVED",
        content: `${actorName} removed the group icon`,
      });
    }

    if (notes.length === 0) {
      return res.status(200).json({
        success: true,
        group: { id: conversationId, ...current },
      });
    }

    const result = await db.$transaction(async (tx) => {
      const group = await tx.conversation.update({
        where: { id: conversationId },
        data,
        select: { id: true, name: true, description: true, avatar: true },
      });

      const messages: MessageRow[] = [];

      for (const note of notes) {
        messages.push(
          await createSystemMessage(tx, {
            conversationId,
            actorId: userId,
            content: note.content,
            metadata: { action: note.action },
          }),
        );
      }

      return { group, messages };
    });

    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, group: result.group });

    for (const message of result.messages) {
      void broadcastNewMessage(message, conversationId, userId);
    }
    void notifyMembers(conversationId);
    if (replacedAvatar) void deleteGroupAvatar(replacedAvatar);
  } catch (error: any) {
    return conflictOrServerError(res, error, "Update Group Error");
  }
};
