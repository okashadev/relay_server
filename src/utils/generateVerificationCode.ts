import crypto from "crypto";

export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_VERIFICATION_ATTEMPTS = 5;

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export const generateVerificationCode = (): string => {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
};

export const normalizeVerificationCode = (code: string): string =>
  code.replace(/\s+/g, "").toUpperCase();

export const hashVerificationCode = (code: string): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined");

  return crypto
    .createHmac("sha256", secret)
    .update(`email-verification:${normalizeVerificationCode(code)}`)
    .digest("hex");
};

export const isVerificationCodeValid = (
  code: string,
  storedHash: string,
): boolean => {
  const submitted = Buffer.from(hashVerificationCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");

  return (
    submitted.length === stored.length &&
    crypto.timingSafeEqual(submitted, stored)
  );
};
