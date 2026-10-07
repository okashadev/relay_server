import { z } from "zod";

const CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f-]{36}$/i;

export const notificationsQuerySchema = z.object({
  cursor: z.string().regex(CURSOR_PATTERN, "Invalid cursor.").optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});