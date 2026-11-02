import { randomUUID } from "node:crypto";
import cloudinary from "../../config/cloudinary.js";

const MB = 1024 * 1024;

export const MAX_AVATAR_BYTES = 5 * MB;

const FORMATS = ["jpg", "png", "webp"];
const MIME_FORMATS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const isAvatarMime = (mime: string) =>
  Boolean(MIME_FORMATS[mime.split(";")[0].trim().toLowerCase()]);

export type AvatarCheck =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): AvatarCheck => ({
  ok: false,
  status,
  error,
});

export const createAvatarMedia = (folder: string) => ({
  newPublicId: (ownerId: string) => `${folder}/${ownerId}/${randomUUID()}`,

  isOwnPublicId: (publicId: string, ownerId: string) =>
    new RegExp(`^${folder}/${ownerId}/[0-9a-f-]{36}$`, "i").test(publicId),

  buildUpload: (publicId: string) => {
    const params = {
      public_id: publicId,
      timestamp: Math.floor(Date.now() / 1000),
      allowed_formats: FORMATS.join(","),
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET as string,
    );

    return {
      url: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      publicId,
      fields: {
        ...params,
        api_key: process.env.CLOUDINARY_API_KEY as string,
        signature,
      },
      maxBytes: MAX_AVATAR_BYTES,
    };
  },

  verify: async (publicId: string): Promise<AvatarCheck> => {
    try {
      const resource = (await cloudinary.api.resource(publicId, {
        resource_type: "image",
      })) as { bytes?: number; format?: string };

      if (
        typeof resource.bytes !== "number" ||
        resource.bytes > MAX_AVATAR_BYTES
      ) {
        return fail(400, "Image is too large. Maximum size is 5 MB.");
      }

      if (!FORMATS.includes(String(resource.format).toLowerCase())) {
        return fail(400, "This image type isn't supported.");
      }

      return {
        ok: true,
        url: cloudinary.url(publicId, {
          secure: true,
          resource_type: "image",
          transformation: [
            {
              width: 256,
              height: 256,
              crop: "fill",
              gravity: "auto",
              quality: "auto",
              fetch_format: "auto",
            },
          ],
        }),
      };
    } catch (error: unknown) {
      const err = error as {
        error?: { http_code?: number };
        http_code?: number;
      };
      const httpCode = err?.error?.http_code ?? err?.http_code;

      if (httpCode === 404)
        return fail(400, "Uploaded image not found. Please upload it again.");
      if (httpCode === 420 || httpCode === 429) {
        return fail(503, "Media service is busy. Please try again shortly.");
      }

      console.error("Avatar lookup failed:", error);
      return fail(502, "Couldn't verify the uploaded image. Please try again.");
    }
  },

  deleteByUrl: async (url: string, ownerId: string) => {
    const match = url.match(
      new RegExp(`(${folder}/${ownerId}/[0-9a-f-]{36})`, "i"),
    );
    if (!match) return;

    try {
      await cloudinary.uploader.destroy(match[1], {
        resource_type: "image",
        invalidate: true,
      });
    } catch (error) {
      console.error("Avatar delete failed:", error);
    }
  },
});

export const profileAvatars = createAvatarMedia("relay/avatars");
