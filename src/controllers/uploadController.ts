import type { Response } from "express";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import cloudinary from "../config/cloudinary.js";
import { signUploadSchema } from "../validators/chatValidator.js";
import {
  MB,
  MEDIA_RULES,
  extensionOf,
  formatFromMime,
  newChatPublicId,
} from "../utils/chat/chatMedia.js";
import {
  badRequest,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";

export const signChatUpload = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return unauthorized(res);

    const result = signUploadSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result.error);

    const { kind, fileName, mimeType, size } = result.data;
    const rule = MEDIA_RULES[kind];

    if (size > rule.maxBytes) {
      return badRequest(
        res,
        `File is too large. Maximum size is ${Math.round(rule.maxBytes / MB)} MB.`,
      );
    }

    const format =
      kind === "FILE" ? extensionOf(fileName) : formatFromMime(kind, mimeType);

    if (!format || !rule.formats.includes(format)) {
      return badRequest(res, "This file type isn't supported.");
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME as string;
    const apiKey = process.env.CLOUDINARY_API_KEY as string;
    const apiSecret = process.env.CLOUDINARY_API_SECRET as string;

    const publicId = newChatPublicId(userId, kind, format);

    const params: Record<string, string | number> = {
      public_id: publicId,
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (kind !== "FILE") params.allowed_formats = rule.formats.join(",");

    const signature = cloudinary.utils.api_sign_request(params, apiSecret);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      upload: {
        url: `https://api.cloudinary.com/v1_1/${cloudName}/${rule.resourceType}/upload`,
        publicId,
        fields: { ...params, api_key: apiKey, signature },
        maxBytes: rule.maxBytes,
      },
    });
  } catch (error: any) {
    console.error("Sign Upload Error:", error);
    return serverError(res);
  }
};