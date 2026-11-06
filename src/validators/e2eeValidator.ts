import { z } from "zod";
import { b64 } from "../utils/e2ee/keyBundle.js";

const publicKey = b64(44).length(44, "Invalid key.");
const secretKey = b64(44).length(44, "Invalid key.");

const backupSchema = z.object({
  data: b64(8192),
  salt: b64(64),
  kdf: z.literal("argon2id"),
  kdfParams: z.object({
    m: z.number().int().min(19456).max(1_048_576),
    t: z.number().int().min(2).max(10),
    p: z.number().int().min(1).max(16),
  }),
});

export const setupAccountSchema = z.object({
  accountPublicKey: publicKey,
  accountSecretKey: secretKey,
});

export const updateBackupSchema = z.object({ backup: backupSchema });

export const disableBackupSchema = z.object({
  accountSecretKey: secretKey,
});

export const resetAccountSchema = z.object({
  accountPublicKey: publicKey,
  accountSecretKey: secretKey,
  password: z.string().min(1).max(128).optional(),
});

export const deviceKeySchema = z.object({
  deviceId: z.uuid("Invalid device id."),
  publicKey,
});

export const accountKeysSchema = z.object({
  keys: z
    .array(
      z.object({
        conversationId: z.uuid("Invalid conversation id."),
        epoch: z.number().int().min(1).max(1_000_000),
        wrappedKey: b64(1024),
      }),
    )
    .min(1)
    .max(200),
});

export const publicKeysSchema = z.object({
  userIds: z.array(z.uuid("Invalid user id.")).min(1).max(100),
});

export const conversationKeysQuerySchema = z.object({
  deviceId: z.uuid("Invalid device id."),
});

export const deviceParamSchema = z.object({ id: z.uuid("Invalid device id.") });
