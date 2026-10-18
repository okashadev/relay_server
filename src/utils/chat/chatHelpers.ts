import { Response } from "express";
import { ConversationRow, OtherUser } from "../../types/conversationTypes.js";
import { ChatAccess } from "./chatAccess.js";
import { PREVIEW_LENGTH } from "./chatConstants.js";

export const truncate = (text: string | null) =>
  text ? Array.from(text).slice(0, PREVIEW_LENGTH).join("") : null;

export const toConversationResponse = (
  conversation: ConversationRow,
  otherUser: OtherUser,
) => {
  const mine = conversation.participants[0];

  return {
    id: conversation.id,
    type: conversation.type,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    otherUser,
    me: {
      isMuted: Boolean(mine?.mutedUntil && mine.mutedUntil > new Date()),
      isPinned: Boolean(mine?.pinnedAt),
      isArchived: mine?.isArchived ?? false,
    },
  };
};

export const denyAccess = (
  res: Response,
  access: Extract<ChatAccess, { ok: false }>,
) => res.status(access.status).json({ success: false, error: access.error });
