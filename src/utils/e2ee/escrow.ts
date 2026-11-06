import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";

const escrowKey = () => {
  const raw = Buffer.from(process.env.E2EE_ESCROW_KEY ?? "", "base64");
  if (raw.length !== 32)
    throw new Error("E2EE_ESCROW_KEY must be 32 bytes (base64).");
  return raw;
};

export const escrowSeal = (secretB64: string, userId: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", escrowKey(), iv);
  cipher.setAAD(Buffer.from(userId));

  const body = Buffer.concat([
    cipher.update(Buffer.from(secretB64, "base64")),
    cipher.final(),
  ]);
  return Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body]));
};

export const escrowOpen = (data: Uint8Array, userId: string) => {
  const buffer = Buffer.from(data);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    escrowKey(),
    buffer.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(buffer.subarray(12, 28));

  return Buffer.concat([
    decipher.update(buffer.subarray(28)),
    decipher.final(),
  ]).toString("base64");
};

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export const publicKeyFromSecret = (secretB64: string) => {
  const secret = Buffer.from(secretB64, "base64");
  if (secret.length !== 32) return null;

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, secret]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });

  return spki.subarray(spki.length - 32).toString("base64");
};
