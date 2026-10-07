import { z } from "zod";

export const suggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(4),
});

export const sendRequestSchema = z.object({
  receiverId: z.uuid("Invalid user id."),
});

export const searchQuerySchema = z.object({
  q: z
    .string({ error: "Search query is required." })
    .trim()
    .min(2, "Type at least 2 characters to search.")
    .max(50, "Search query is too long."),
});

export const requestIdParamSchema = z.object({
  id: z.uuid("Invalid request id."),
});
