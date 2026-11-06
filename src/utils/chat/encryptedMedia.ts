import { randomUUID } from "node:crypto";
import cloudinary from "../../config/cloudinary.js";

export const MB = 1024 * 1024;
export const CHAT_BLOB_FOLDER = "relay/chat";

export type BlobKind = "IMAGE" | "VIDEO" | "VOICE" | "FILE" | "THUMB";

const SLACK = 1024;

export const BLOB_LIMITS: Record<BlobKind, number> = {
  IMAGE: 10 * MB + SLACK,
  VIDEO: 50 * MB + SLACK,
  VOICE: 10 * MB + SLACK,
  FILE: 10 * MB + SLACK,
  THUMB: 512 * 1024,
};

export const newBlobPublicId = (userId: string) =>
  `${CHAT_BLOB_FOLDER}/${userId}/${randomUUID()}`;

export const isOwnBlobId = (publicId: string, userId: string) =>
  new RegExp(`^${CHAT_BLOB_FOLDER}/${userId}/[0-9a-f-]{36}$`, "i").test(publicId);

export const blobUrl = (publicId: string) =>
  cloudinary.url(publicId, { secure: true, resource_type: "raw" });

export type BlobCheck =
  | { ok: true; url: string; size: number }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): BlobCheck => ({ ok: false, status, error });

export const verifyEncryptedBlob = async (
  publicId: string,
  maxBytes: number,
): Promise<BlobCheck> => {
  try {
    const resource = (await cloudinary.api.resource(publicId, {
      resource_type: "raw",
    })) as { bytes?: number; secure_url?: string };

    if (typeof resource.bytes !== "number" || !resource.secure_url) {
      return fail(502, "Couldn't verify the uploaded file. Please try again.");
    }

    if (resource.bytes > maxBytes) {
      return fail(400, `File is too large. Maximum size is ${Math.round(maxBytes / MB)} MB.`);
    }

    return { ok: true, url: resource.secure_url, size: resource.bytes };
  } catch (error: unknown) {
    const err = error as { error?: { http_code?: number }; http_code?: number };
    const httpCode = err?.error?.http_code ?? err?.http_code;

    if (httpCode === 404) return fail(400, "Uploaded file not found. Please upload it again.");
    if (httpCode === 420 || httpCode === 429) {
      return fail(503, "Media service is busy. Please try again shortly.");
    }

    console.error("Encrypted blob lookup failed:", error);
    return fail(502, "Couldn't verify the uploaded file. Please try again.");
  }
};