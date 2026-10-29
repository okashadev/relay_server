import type { ParticipantRole, Prisma } from "@prisma/client";
import { db } from "../../config/db.js";
import { pairKey } from "../pairKey.js";

export type Db = typeof db | Prisma.TransactionClient;

export type GroupAccess =
  | { ok: true; role: ParticipantRole }
  | { ok: false; status: 403 | 404; error: string };

export const isAdminRole = (role: ParticipantRole) =>
  role === "OWNER" || role === "ADMIN";

export const getGroupActor = async (
  client: Db,
  conversationId: string,
  userId: string,
): Promise<GroupAccess> => {
  const participant = await client.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      role: true,
      leftAt: true,
      conversation: { select: { type: true } },
    },
  });

  if (!participant || participant.conversation.type !== "GROUP") {
    return { ok: false, status: 404, error: "Group not found." };
  }

  if (participant.leftAt) {
    return {
      ok: false,
      status: 403,
      error: "You are no longer a member of this group.",
    };
  }

  return { ok: true, role: participant.role };
};

export const getInvitableIds = async (
  userId: string,
  candidateIds: string[],
): Promise<string[]> => {
  const [friendships, blocks, users] = await Promise.all([
    db.friendship.findMany({
      where: {
        status: "ACCEPTED",
        pairKey: { in: candidateIds.map((id) => pairKey(userId, id)) },
      },
      select: { senderId: true, receiverId: true },
    }),
    db.block.findMany({
      where: {
        OR: [
          { blockerId: userId, blockedId: { in: candidateIds } },
          { blockedId: userId, blockerId: { in: candidateIds } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    }),
    db.user.findMany({
      where: { id: { in: candidateIds }, isEmailVerified: true },
      select: { id: true },
    }),
  ]);

  const friendIds = new Set(
    friendships.map((friendship) =>
      friendship.senderId === userId ? friendship.receiverId : friendship.senderId,
    ),
  );
  const blocked = new Set(
    blocks.map((block) =>
      block.blockerId === userId ? block.blockedId : block.blockerId,
    ),
  );
  const verified = new Set(users.map((user) => user.id));

  return candidateIds.filter(
    (id) => friendIds.has(id) && verified.has(id) && !blocked.has(id),
  );
};

export const latestMessageAt = async (
  client: Db,
  conversationId: string,
): Promise<Date | null> => {
  const result = await client.message.aggregate({
    where: { conversationId },
    _max: { createdAt: true },
  });

  return result._max.createdAt;
};

export const nameMap = async (client: Db, ids: string[]) => {
  const users = await client.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });

  return new Map(users.map((user) => [user.id, user.name]));
};

export const joinNames = (names: string[]) => {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
};