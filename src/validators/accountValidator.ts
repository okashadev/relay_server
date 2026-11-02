import { z } from "zod";
import { emailField, withinBcryptLimit } from "./authValidator.js";

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(128),
  newPassword: z
    .string({ error: "Password is required." })
    .min(8, "Password must be at least 8 characters long.")
    .refine(withinBcryptLimit, "Password is too long."),
});

export const emailQuerySchema = z.object({ email: emailField });

export const requestEmailChangeSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Password is required." })
    .min(8, "Password must be at least 8 characters long.")
    .refine(withinBcryptLimit, "Password is too long."),
});
