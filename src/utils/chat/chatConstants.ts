import { Prisma } from "@prisma/client";
import { ConversationRow, OtherUser } from "../../types/conversationTypes.js";

export const MAX_MEMBERS = 500;
export const MAX_CHATS = 100;
export const PREVIEW_LENGTH = 120;
export const UNREAD_CAP = 100;
export const MAX_PINNED_CHATS = 3;
export const MUTE_FOREVER = new Date("9999-12-31T23:59:59.000Z");
export const MUTE_DURATIONS_MS = {
  "8h": 8 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
} as const;

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const EDITABLE_TYPES = new Set<string>([
  "TEXT",
  "IMAGE",
  "VIDEO",
  "FILE",
]);

export const otherUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
  bio: true,
  status: true,
  lastSeen: true,
} satisfies Prisma.UserSelect;

export const conversationSelect = (userId: string) =>
  ({
    id: true,
    type: true,
    lastMessageAt: true,
    createdAt: true,
    participants: {
      where: { userId },
      select: { mutedUntil: true, pinnedAt: true, isArchived: true },
    },
  }) satisfies Prisma.ConversationSelect;

export const DELETED_USER: OtherUser = {
  id: "deleted",
  name: "Deleted user",
  username: "deleted",
  avatar: null,
  bio: null,
  status: "OFFLINE",
  lastSeen: null,
};

export const listUserSelect = {
  id: true,
  name: true,
  avatar: true,
  status: true,
} satisfies Prisma.UserSelect;
