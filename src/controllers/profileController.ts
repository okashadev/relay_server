import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { authUserSelect } from "../utils/auth/authUser.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  conflict,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import {
  MAX_AVATAR_BYTES,
  isAvatarMime,
  profileAvatars,
} from "../utils/media/avatarMedia.js";
import {
  signAvatarSchema,
  updateProfileSchema,
  usernameQuerySchema,
} from "../validators/profileValidator.js";

export const checkUsername = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = usernameQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);

    const taken = await db.user.findFirst({
      where: {
        username: { equals: parsed.data.username, mode: "insensitive" },
        id: { not: userId },
      },
      select: { id: true },
    });

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true, available: !taken });
  } catch (error: any) {
    console.error("Check Username Error:", error);
    return serverError(res);
  }
};

export const signProfileAvatar = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = signAvatarSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    if (!isAvatarMime(parsed.data.mimeType)) {
      return badRequest(res, "Use a JPG, PNG or WebP image.");
    }

    if (parsed.data.size > MAX_AVATAR_BYTES) {
      return badRequest(res, "Image is too large. Maximum size is 5 MB.");
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      upload: profileAvatars.buildUpload(profileAvatars.newPublicId(userId)),
    });
  } catch (error: any) {
    console.error("Sign Profile Avatar Error:", error);
    return serverError(res);
  }
};

export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { name, username, bio, avatarPublicId, removeAvatar } = parsed.data;

    if (avatarPublicId && removeAvatar) {
      return badRequest(res, "Choose either a new photo or remove it.");
    }

    const current = await db.user.findUnique({
      where: { id: userId },
      select: authUserSelect,
    });

    if (!current) return unauthorized(res);

    const data: Prisma.UserUpdateInput = {};

    if (name !== undefined && name !== current.name) data.name = name;
    if (username !== undefined && username !== current.username) data.username = username;
    if (bio !== undefined && (bio || null) !== current.bio) data.bio = bio || null;

    let replacedAvatar: string | null = null;

    if (avatarPublicId) {
      if (!profileAvatars.isOwnPublicId(avatarPublicId, userId)) {
        return badRequest(res, "Invalid image reference.");
      }

      const check = await profileAvatars.verify(avatarPublicId);

      if (!check.ok) {
        return res.status(check.status).json({ success: false, error: check.error });
      }

      data.avatar = check.url;
      replacedAvatar = current.avatar;
    } else if (removeAvatar && current.avatar) {
      data.avatar = null;
      replacedAvatar = current.avatar;
    }

    res.set("Cache-Control", "no-store");

    if (Object.keys(data).length === 0) {
      return res.status(200).json({ success: true, user: current });
    }

    let updated;

    try {
      updated = await db.user.update({
        where: { id: userId },
        data,
        select: authUserSelect,
      });
    } catch (error: any) {
      if (error?.code === "P2002") return conflict(res, "That username is already taken.");
      throw error;
    }

    res.status(200).json({ success: true, user: updated });

    if (replacedAvatar) void profileAvatars.deleteByUrl(replacedAvatar, userId);
  } catch (error: any) {
    console.error("Update Profile Error:", error);
    return serverError(res);
  }
};