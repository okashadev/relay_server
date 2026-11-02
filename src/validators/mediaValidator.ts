import { z } from "zod";

export const mediaQuerySchema = z.object({
  kind: z.enum(["media", "files"]),
  conversationId: z.uuid("Invalid conversation id.").optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(40),
});