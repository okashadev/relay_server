import { z } from "zod";
import {
  MAX_ADD_AT_ONCE,
  MAX_DESCRIPTION_LENGTH,
  MAX_GROUP_MEMBERS,
  MAX_NAME_LENGTH,
} from "../utils/group/groupConstants.js";

const name = z
  .string()
  .trim()
  .min(1, "Group name is required.")
  .max(
    MAX_NAME_LENGTH,
    `Group name cannot exceed ${MAX_NAME_LENGTH} characters.`,
  );

const description = z
  .string()
  .trim()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
  );

export const groupIdParamSchema = z.object({
  id: z.uuid("Invalid group id."),
});

export const groupMemberParamSchema = z.object({
  id: z.uuid("Invalid group id."),
  memberId: z.uuid("Invalid user id."),
});

export const createGroupSchema = z.object({
  name,
  description: description.optional(),
  memberIds: z
    .array(z.uuid("Invalid user id."))
    .min(2, "Please select at least 2 people.")
    .max(MAX_GROUP_MEMBERS - 1, "Too many members selected."),
});

export const addMembersSchema = z.object({
  memberIds: z
    .array(z.uuid("Invalid user id."))
    .min(1, "Select at least one friend to add.")
    .max(
      MAX_ADD_AT_ONCE,
      `You can add up to ${MAX_ADD_AT_ONCE} people at once.`,
    ),
});

export const updateGroupSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    avatarPublicId: z.string().min(1).max(200).optional(),
    removeAvatar: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

export const memberRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
});

export const signAvatarSchema = z.object({
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});
