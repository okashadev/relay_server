import { z } from "zod";
import { RESERVED_USERNAMES } from "./authValidator.js";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, "Use 3–20 letters, numbers or underscores.")
  .refine((value) => !RESERVED_USERNAMES.has(value), "This username isn't available.");

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, "Name can't be empty.").max(50, "Name is too long."),
    username: usernameSchema,
    bio: z.string().trim().max(160, "Bio cannot exceed 160 characters."),
    avatarPublicId: z.string().min(1).max(200),
    removeAvatar: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

export const usernameQuerySchema = z.object({ username: usernameSchema });

export const signAvatarSchema = z.object({
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});