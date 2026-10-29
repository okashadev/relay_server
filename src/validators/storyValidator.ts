import { z } from "zod";

const publicId = z.string().min(1).max(200);
const mediaCaption = z
  .string()
  .trim()
  .max(300, "Caption is too long.")
  .nullish();

export const storyIdParamSchema = z.object({
  id: z.uuid("Invalid story id."),
});

export const signStoryUploadSchema = z.object({
  kind: z.enum(["IMAGE", "VIDEO"]),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export const createStorySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TEXT"),
    caption: z
      .string()
      .trim()
      .min(1, "Story can't be empty.")
      .max(280, "Story text is too long."),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Invalid colour.")
      .default("#1D4533"),
  }),
  z.object({ type: z.literal("IMAGE"), publicId, caption: mediaCaption }),
  z.object({ type: z.literal("VIDEO"), publicId, caption: mediaCaption }),
]);

export const storyReplySchema = z.object({
  clientId: z.uuid("Invalid client id."),
  content: z
    .string()
    .trim()
    .min(1, "Reply can't be empty.")
    .max(500, "Reply is too long."),
});
