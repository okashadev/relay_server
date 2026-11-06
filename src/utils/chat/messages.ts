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
  ciphertext: true,
  keyEpoch: true,
  mediaUrl: true,
  thumbnailUrl: true,
  mediaSize: true,
  replyTo: {
    select: {
      id: true,
      type: true,
      ciphertext: true,
      keyEpoch: true,
      createdAt: true,
      deletedAt: true,
      sender: { select: { name: true } },
    },
  },
  storyId: true,
  story: {
    select: {
      id: true,
      type: true,
      thumbnailUrl: true,
      caption: true,
      backgroundColor: true,
      expiresAt: true,
      deletedAt: true,
    },
  },
  reactions: { select: { emoji: true, userId: true } },
  editedAt: true,
  deletedAt: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

const summarizeReactions = (
  reactions: { emoji: string; userId: string }[],
  viewerId: string,
) => {
  const byEmoji = new Map<string, { emoji: string; count: number; reactedByMe: boolean }>();

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

  const hideReply =
    reply !== null &&
    (reply.deletedAt !== null || (clearedAt !== null && reply.createdAt <= clearedAt));

  const story = message.story;
  const storyAvailable =
    story !== null && story.deletedAt === null && story.expiresAt > new Date();

  return {
    id: message.id,
    clientId: message.senderId === viewerId ? message.clientId : null,
    senderId: message.senderId,
    sender: message.sender,
    type: message.type,
    content: isDeleted ? null : message.content,
    ciphertext: isDeleted ? null : message.ciphertext,
    keyEpoch: isDeleted ? null : message.keyEpoch,
    mediaUrl: isDeleted ? null : message.mediaUrl,
    thumbnailUrl: isDeleted ? null : message.thumbnailUrl,
    mediaSize: isDeleted ? null : message.mediaSize,
    replyTo:
      reply && !isDeleted
        ? {
            id: reply.id,
            type: reply.type,
            ciphertext: hideReply ? null : reply.ciphertext,
            keyEpoch: hideReply ? null : reply.keyEpoch,
            senderName: reply.sender?.name ?? null,
            deleted: reply.deletedAt !== null,
          }
        : null,
    story:
      story && !isDeleted
        ? {
            id: story.id,
            type: story.type,
            available: storyAvailable,
            thumbnailUrl: storyAvailable ? story.thumbnailUrl : null,
            caption: storyAvailable ? story.caption : null,
            backgroundColor: storyAvailable ? story.backgroundColor : null,
          }
        : null,
    reactions: isDeleted ? [] : summarizeReactions(message.reactions, viewerId),
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
  };
};