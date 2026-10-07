import z from "zod";

const MAX_PASSWORD_BYTES = 72;

const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "moderator",
  "api",
  "null",
  "undefined",
]);

const emailField = z
  .string({ error: "Email is required." })
  .trim()
  .toLowerCase()
  .max(254, "Email is too long.")
  .pipe(z.email("Please enter a valid email address."));

const codeField = z
  .string({ error: "Verification code is required." })
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-HJ-KM-NP-Z2-9]{8}$/, "Invalid or expired code."));

const withinBcryptLimit = (value: string) =>
  Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES;

export const registerSchema = z.object({
  name: z
    .string({ error: "Name is required." })
    .trim()
    .min(2, "Name must be at least 2 characters long.")
    .max(30, "Name cannot exceed 30 characters."),

  username: z
    .string({ error: "Username is required." })
    .trim()
    .toLowerCase()
    .min(3, "Username must be at least 3 characters long.")
    .max(20, "Username cannot exceed 20 characters.")
    .regex(
      /^[a-z0-9_]+$/,
      "Username can only contain letters, numbers and underscores.",
    )
    .refine(
      (value) => !RESERVED_USERNAMES.has(value),
      "This username is not available.",
    ),

  email: emailField,

  password: z
    .string({ error: "Password is required." })
    .min(8, "Password must be at least 8 characters long.")
    .refine(withinBcryptLimit, "Password is too long."),
});

export const loginSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Password is required." })
    .min(1, "Password is required.")
    .refine(withinBcryptLimit, "Invalid email or password."),
});

export const verifyEmailSchema = z.object({
  email: emailField,
  code: codeField,
});

export const resendCodeSchema = z.object({
  email: emailField,
});
