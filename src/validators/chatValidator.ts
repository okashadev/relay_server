import z from "zod";
import { b64, keyBundleSchema } from "../utils/e2ee/keyBundle.js";

const CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f-]{36}$/i;

const CIPHERTEXT_MAX = 26_000;
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

export const sendMessageSchema = z
  .object({
    clientId: z.uuid("Invalid client id."),
    type: z.enum(["TEXT", "IMAGE", "VIDEO", "VOICE", "FILE"]),
    ciphertext: b64(CIPHERTEXT_MAX),
    keyEpoch: z.number().int().min(1),
    replyToId: z.uuid().nullish(),
    media: z
      .object({
        publicId: z.string().min(1).max(200),
        thumbnailPublicId: z.string().min(1).max(200).optional(),
      })
      .optional(),
    keyBundle: keyBundleSchema.optional(),
    deviceId: z.uuid("Invalid device id."),
  })
  .refine(
    (value) => (value.type === "TEXT") === (value.media === undefined),
    "Attachments need media, and text messages can't have it.",
  );

export const signUploadSchema = z.object({
  kind: z.enum(["IMAGE", "VIDEO", "VOICE", "FILE", "THUMB"]),
  size: z.number().int().positive(),
});

export const messageParamsSchema = z.object({
  id: z.uuid("Invalid conversation id."),
  messageId: z.uuid("Invalid message id."),
});

export const editMessageSchema = z.object({
  ciphertext: b64(CIPHERTEXT_MAX),
  keyEpoch: z.number().int().min(1),
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
