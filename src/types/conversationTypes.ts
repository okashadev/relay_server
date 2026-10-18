import { ConversationType, MessageType } from "@prisma/client";

export type ConversationRow = {
  id: string;
  type: ConversationType;
  lastMessageAt: Date;
  createdAt: Date;
  participants: {
    mutedUntil: Date | null;
    pinnedAt: Date | null;
    isArchived: boolean;
  }[];
};

export type OtherUser = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  bio: string | null;
  status: "ONLINE" | "OFFLINE";
  lastSeen: Date | null;
};

export type LastMessageRow = {
  conversationId: string;
  type: MessageType;
  content: string | null;
  fileName: string | null;
  senderId: string | null;
  senderName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  unreadCount: number;
};