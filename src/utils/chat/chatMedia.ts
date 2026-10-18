import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import cloudinary from "../../config/cloudinary.js";

export type MediaKind = "IMAGE" | "VIDEO" | "VOICE" | "FILE";
type ResourceType = "image" | "video" | "raw";

export const MB = 1024 * 1024;
export const CHAT_MEDIA_FOLDER = "relay/chat";

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
  VOICE: {
    webm: "audio/webm",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
  },
  FILE: {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
  },
};

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/x-m4a": "audio/mp4",
  "audio/x-wav": "audio/wav",
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
  VOICE: {
    resourceType: "video",
    maxBytes: 10 * MB,
    formats: Object.keys(FORMAT_MIME.VOICE),
  },
  FILE: {
    resourceType: "raw",
    maxBytes: 10 * MB,
    formats: Object.keys(FORMAT_MIME.FILE),
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

export const newChatPublicId = (
  userId: string,
  kind: MediaKind,
  format: string,
) =>
  `${CHAT_MEDIA_FOLDER}/${userId}/${randomUUID()}${
    kind === "FILE" ? `.${format}` : ""
  }`;

export const isOwnPublicId = (
  publicId: string,
  userId: string,
  kind: MediaKind,
) => {
  const prefix = `${CHAT_MEDIA_FOLDER}/${userId}/`;
  if (!publicId.startsWith(prefix)) return false;

  const name = publicId.slice(prefix.length);
  const pattern =
    kind === "FILE" ? /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/ : /^[0-9a-f-]{36}$/;

  return pattern.test(name);
};

export const sanitizeFileName = (name: string) =>
  name
    .replace(/[\\/\p{Cc}]/gu, "")
    .trim()
    .slice(0, 150) || "file";

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
        { width: 480, crop: "limit", quality: "auto", fetch_format: "auto" },
      ],
    });
  }

  if (kind === "VIDEO") {
    return cloudinary.url(publicId, {
      secure: true,
      resource_type: "video",
      format: "jpg",
      transformation: [{ width: 480, crop: "limit" }],
    });
  }

  return null;
};

type CloudinaryResource = {
  secure_url?: string;
  bytes?: number;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
};

export const verifyChatMedia = async (
  kind: MediaKind,
  publicId: string,
): Promise<MediaCheck> => {
  const rule = MEDIA_RULES[kind];

  let resource: CloudinaryResource;

  try {
    resource = await cloudinary.api.resource(publicId, {
      resource_type: rule.resourceType,
    });
  } catch (error: any) {
    const httpCode = error?.error?.http_code ?? error?.http_code;

    if (httpCode === 404) {
      return fail(400, "Uploaded file not found. Please upload it again.");
    }
    if (httpCode === 420 || httpCode === 429) {
      return fail(503, "Media service is busy. Please try again shortly.");
    }

    console.error("Cloudinary resource lookup failed:", error);
    return fail(502, "Couldn't verify the uploaded file. Please try again.");
  }

  if (typeof resource.bytes !== "number" || !resource.secure_url) {
    return fail(502, "Couldn't verify the uploaded file. Please try again.");
  }

  if (resource.bytes > rule.maxBytes) {
    return fail(
      400,
      `File is too large. Maximum size is ${Math.round(rule.maxBytes / MB)} MB.`,
    );
  }

  const format =
    kind === "FILE"
      ? extensionOf(publicId)
      : String(resource.format ?? "").toLowerCase();

  if (!rule.formats.includes(format)) {
    return fail(400, "This file type isn't supported.");
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

export const parseChatMediaUrl = (
  url: string,
): { resourceType: ResourceType; publicId: string } | null => {
  const match = url.match(/\/(image|video|raw)\/upload\/(?:v\d+\/)?([^?#]+)/);
  if (!match) return null;

  const resourceType = match[1] as ResourceType;
  let publicId = decodeURIComponent(match[2]);

  if (resourceType !== "raw") publicId = publicId.replace(/\.[a-z0-9]+$/i, "");

  return { resourceType, publicId };
};

export const deleteChatMedia = async (url: string, ownerId: string) => {
  const parsed = parseChatMediaUrl(url);
  if (!parsed) return;

  if (!parsed.publicId.startsWith(`${CHAT_MEDIA_FOLDER}/${ownerId}/`)) return;

  try {
    await cloudinary.uploader.destroy(parsed.publicId, {
      resource_type: parsed.resourceType,
      invalidate: true,
    });
  } catch (error) {
    console.error("Cloudinary delete failed:", error);
  }
};