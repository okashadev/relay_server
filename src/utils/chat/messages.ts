import { Prisma } from "@prisma/client";

const messageSenderSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
} satisfies Prisma.UserSelect;

export const messageSelect = {
  id: true,
  clientId: true,
  senderId: true,
  sender: { select: messageSenderSelect },
  type: true,
  content: true,
  mediaUrl: true,
  thumbnailUrl: true,
  mediaMimeType: true,
  fileName: true,
  mediaSize: true,
  mediaWidth: true,
  mediaHeight: true,
  mediaDuration: true,
  replyTo: {
    select: {
      id: true,
      type: true,
      fileName: true,
      content: true,
      createdAt: true,
      deletedAt: true,
      sender: { select: { name: true } },
    },
  },
  reactions: { select: { emoji: true, userId: true } },
  editedAt: true,
  deletedAt: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;

const summarizeReactions = (
  reactions: { emoji: string; userId: string }[],
  viewerId: string,
) => {
  const byEmoji = new Map<
    string,
    { emoji: string; count: number; reactedByMe: boolean }
  >();

  for (const reaction of reactions) {
    const entry = byEmoji.get(reaction.emoji) ?? {
      emoji: reaction.emoji,
      count: 0,
      reactedByMe: false,
    };

    entry.count += 1;
    if (reaction.userId === viewerId) entry.reactedByMe = true;
    byEmoji.set(reaction.emoji, entry);
  }

  return [...byEmoji.values()].sort(
    (a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji),
  );
};

export const serializeMessage = (
  message: MessageRow,
  viewerId: string,
  clearedAt: Date | null,
) => {
  const isDeleted = message.deletedAt !== null;
  const reply = message.replyTo;

  const hideReplyContent =
    reply !== null &&
    (reply.deletedAt !== null ||
      (clearedAt !== null && reply.createdAt <= clearedAt));

  return {
    id: message.id,
    clientId: message.senderId === viewerId ? message.clientId : null,
    senderId: message.senderId,
    sender: message.sender,
    type: message.type,
    content: isDeleted ? null : message.content,
    mediaUrl: isDeleted ? null : message.mediaUrl,
    thumbnailUrl: isDeleted ? null : message.thumbnailUrl,
    mediaMimeType: isDeleted ? null : message.mediaMimeType,
    fileName: isDeleted ? null : message.fileName,
    mediaSize: isDeleted ? null : message.mediaSize,
    mediaWidth: isDeleted ? null : message.mediaWidth,
    mediaHeight: isDeleted ? null : message.mediaHeight,
    mediaDuration: isDeleted ? null : message.mediaDuration,
    replyTo:
      reply && !isDeleted
        ? {
            id: reply.id,
            type: reply.type,
            fileName: hideReplyContent ? null : reply.fileName,
            content: hideReplyContent ? null : reply.content,
            senderName: reply.sender?.name ?? null,
            deleted: reply.deletedAt !== null,
          }
        : null,
    reactions: isDeleted ? [] : summarizeReactions(message.reactions, viewerId),
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
  };
};