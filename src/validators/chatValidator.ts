import z from "zod";

const CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f-]{36}$/i;

const clientId = z.uuid("Invalid client id.");
const replyToId = z.uuid("Invalid reply id.").nullish();
const caption = z.string().trim().max(1000, "Caption is too long.").nullish();
const publicId = z.string().min(1).max(200);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const newChatSchema = z.object({
  otherUserId: z.uuid("Invalid user id."),
});

export const conversationIdParamSchema = z.object({
  id: z.uuid("Invalid conversation id."),
});

export const messagesQuerySchema = z.object({
  cursor: z.string().regex(CURSOR_PATTERN, "Invalid cursor.").optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const sendMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TEXT"),
    clientId,
    replyToId,
    content: z
      .string()
      .trim()
      .min(1, "Message can't be empty.")
      .max(4000, "Message is too long."),
  }),
  z.object({
    type: z.literal("IMAGE"),
    clientId,
    replyToId,
    publicId,
    content: caption,
  }),
  z.object({
    type: z.literal("VIDEO"),
    clientId,
    replyToId,
    publicId,
    content: caption,
  }),
  z.object({
    type: z.literal("VOICE"),
    clientId,
    replyToId,
    publicId,
  }),
  z.object({
    type: z.literal("FILE"),
    clientId,
    replyToId,
    publicId,
    fileName: z.string().trim().min(1).max(150),
    content: caption,
  }),
]);

export const signUploadSchema = z.object({
  kind: z.enum(["IMAGE", "VIDEO", "VOICE", "FILE"]),
  fileName: z.string().trim().min(1).max(150),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export const messageParamsSchema = z.object({
  id: z.uuid("Invalid conversation id."),
  messageId: z.uuid("Invalid message id."),
});

export const editMessageSchema = z.object({
  content: z.string().trim().max(4000, "Message is too long."),
});

export const reactionSchema = z.object({
  emoji: z
    .string()
    .trim()
    .min(1, "Unsupported reaction.")
    .max(32, "Unsupported reaction.")
    .refine(
      (v) =>
        [...graphemes.segment(v)].length === 1 &&
        /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(v),
      "Unsupported reaction.",
    ),
});

export const deleteMessageQuerySchema = z.object({
  scope: z.enum(["me", "everyone"], { error: "Invalid delete option." }),
});

export const chatSettingsSchema = z
  .object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    mute: z.enum(["8h", "1w", "forever"]).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

export const blockBodySchema = z.object({
  userId: z.uuid("Invalid user id."),
});

export const blockParamsSchema = z.object({
  userId: z.uuid("Invalid user id."),
});

export const searchQuerySchema = z.object({
  q: z
    .string({ error: "Search query is required." })
    .trim()
    .min(2, "Type at least 2 characters to search.")
    .max(50, "Search query is too long."),
});
