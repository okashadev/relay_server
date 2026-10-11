import z from "zod";

export const newChatSchema = z.object({
  otherUserId: z.uuid("Invalid user id."),
});
