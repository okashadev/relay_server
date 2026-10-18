import { db } from "../config/db.js";
import { SOCKET_EVENTS } from "../socket/events.js";
import { emitToUser } from "../socket/socketServer.js";
import {
  PublicUser,
  Relationship,
  UserWithRelationship,
} from "../types/friendsTypes.js";

export const notifyRelationship = (
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

export const attachRelationships = async (
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
