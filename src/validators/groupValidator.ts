import z from "zod";

export const createGroupSchema = z.object({
  name: z.string().max(30, "Group name cannot exceed 30 characters"),
  description: z.string().max(300, "Description cannot exceed 300 characters"),
  memberIds: z.array(z.string()).min(1, "At least one member is required"),
});
