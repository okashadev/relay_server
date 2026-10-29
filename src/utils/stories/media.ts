import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import cloudinary from "../../config/cloudinary.js";

export type MediaKind = "IMAGE" | "VIDEO";
type ResourceType = "image" | "video";

export const MB = 1024 * 1024;
export const STORY_MEDIA_FOLDER = "relay/stories";

const FORMAT_MIME: Record<MediaKind, Record<string, string>> = {
  IMAGE: {
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  },
  VIDEO: {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  },
};

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
};

type MediaRule = {
  resourceType: ResourceType;
  maxBytes: number;
  formats: string[];
};

export const MEDIA_RULES: Record<MediaKind, MediaRule> = {
  IMAGE: {
    resourceType: "image",
    maxBytes: 10 * MB,
    formats: Object.keys(FORMAT_MIME.IMAGE),
  },
  VIDEO: {
    resourceType: "video",
    maxBytes: 50 * MB,
    formats: Object.keys(FORMAT_MIME.VIDEO),
  },
};

export const extensionOf = (fileName: string) =>
  extname(fileName).slice(1).toLowerCase();

export const formatFromMime = (
  kind: MediaKind,
  mime: string,
): string | null => {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const canonical = MIME_ALIASES[normalized] ?? normalized;

  const match = Object.entries(FORMAT_MIME[kind]).find(
    ([, value]) => value === canonical,
  );

  return match ? match[0] : null;
};

export const newStoryPublicId = (userId: string, _kind: MediaKind) =>
  `${STORY_MEDIA_FOLDER}/${userId}/${randomUUID()}`;

export const isOwnStoryPublicId = (publicId: string, userId: string) => {
  const prefix = `${STORY_MEDIA_FOLDER}/${userId}/`;

  if (!publicId.startsWith(prefix)) return false;

  const name = publicId.slice(prefix.length);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    name,
  );
};

export type VerifiedMedia = {
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
};

export type MediaCheck =
  | { ok: true; media: VerifiedMedia }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): MediaCheck => ({
  ok: false,
  status,
  error,
});

const buildThumbnail = (kind: MediaKind, publicId: string): string | null => {
  if (kind === "IMAGE") {
    return cloudinary.url(publicId, {
      secure: true,
      resource_type: "image",
      transformation: [
        {
          width: 480,
          crop: "limit",
          quality: "auto",
          fetch_format: "auto",
        },
      ],
    });
  }

  return cloudinary.url(publicId, {
    secure: true,
    resource_type: "video",
    format: "jpg",
    transformation: [{ width: 480, crop: "limit" }],
  });
};

type CloudinaryResource = {
  secure_url?: string;
  bytes?: number;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
};

export const verifyStoryMedia = async (
  kind: MediaKind,
  publicId: string,
): Promise<MediaCheck> => {
  const rule = MEDIA_RULES[kind];

  let resource: CloudinaryResource;

  try {
    resource = await cloudinary.api.resource(publicId, {
      resource_type: rule.resourceType,
    });
  } catch (error: unknown) {
    const cloudinaryError = error as {
      error?: { http_code?: number };
      http_code?: number;
    };

    const httpCode =
      cloudinaryError?.error?.http_code ?? cloudinaryError?.http_code;

    if (httpCode === 404) {
      return fail(
        400,
        "Uploaded story media not found. Please upload it again.",
      );
    }

    if (httpCode === 420 || httpCode === 429) {
      return fail(503, "Media service is busy. Please try again shortly.");
    }

    console.error("Cloudinary story media lookup failed:", error);

    return fail(
      502,
      "Couldn't verify the uploaded story media. Please try again.",
    );
  }

  if (typeof resource.bytes !== "number" || !resource.secure_url) {
    return fail(
      502,
      "Couldn't verify the uploaded story media. Please try again.",
    );
  }

  if (resource.bytes > rule.maxBytes) {
    return fail(
      400,
      `File is too large. Maximum size is ${Math.round(rule.maxBytes / MB)} MB.`,
    );
  }

  const format = String(resource.format ?? "").toLowerCase();

  if (!rule.formats.includes(format)) {
    return fail(400, "This story media type isn't supported.");
  }

  return {
    ok: true,
    media: {
      url: resource.secure_url,
      thumbnailUrl: buildThumbnail(kind, publicId),
      mimeType: FORMAT_MIME[kind][format],
      size: resource.bytes,
      width: typeof resource.width === "number" ? resource.width : null,
      height: typeof resource.height === "number" ? resource.height : null,
      duration:
        typeof resource.duration === "number"
          ? Math.round(resource.duration)
          : null,
    },
  };
};

export const parseStoryMediaUrl = (
  url: string,
): { resourceType: ResourceType; publicId: string } | null => {
  const match = url.match(/\/(image|video)\/upload\/(?:v\d+\/)?([^?#]+)/);

  if (!match) return null;

  const resourceType = match[1] as ResourceType;

  let publicId: string;

  try {
    publicId = decodeURIComponent(match[2]);
  } catch {
    return null;
  }

  publicId = publicId.replace(/\.[a-z0-9]+$/i, "");

  return { resourceType, publicId };
};

export const deleteStoryMedia = async (url: string, ownerId: string) => {
  const parsed = parseStoryMediaUrl(url);

  if (!parsed) return;

  if (!parsed.publicId.startsWith(`${STORY_MEDIA_FOLDER}/${ownerId}/`)) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(parsed.publicId, {
      resource_type: parsed.resourceType,
      invalidate: true,
    });
  } catch (error) {
    console.error("Cloudinary story media delete failed:", error);
  }
};
