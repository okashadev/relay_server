import type { Response } from "express";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import {
  sendEmailChangedNotice,
  sendPasswordChangedEmail,
} from "../utils/auth/accountMail.js";
import { hashPassword, verifyPassword } from "../utils/auth/password.js";
import { revokeOtherSessions } from "../utils/auth/sessions.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  serverError,
  tooManyRequests,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import {
  changePasswordSchema,
  requestEmailChangeSchema,
  emailQuerySchema,
} from "../validators/accountValidator.js";
import {
  generateVerificationCode,
  hashVerificationCode,
  isVerificationCodeValid,
  MAX_VERIFICATION_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  VERIFICATION_CODE_TTL_MS,
} from "../utils/generateVerificationCode.js";
import { sendVerificationEmail } from "../lib/email.js";
import { Prisma } from "@prisma/client";
import {
  resendCodeSchema,
  verifyEmailSchema,
} from "../validators/authValidator.js";

const INVALID_CODE_ERROR = "Invalid or expired code.";
const IN_USE_ERROR = "This email address is already in use.";
const GOOGLE_EMAIL_ERROR =
  "Your account signs in with Google, so its email can't be changed here.";

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const isEmailTaken = async (email: string, exceptUserId: string) =>
  (await db.user.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      id: { not: exceptUserId },
    },
    select: { id: true },
  })) !== null;

const mailFailed = async (res: Response, userId: string) => {
  await db.user
    .updateMany({
      where: { id: userId },
      data: { verificationLastSentAt: null },
    })
    .catch(() => undefined);

  return res.status(502).json({
    success: false,
    error: "We couldn't send the email. Please try again in a minute.",
  });
};

export const changePassword = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { currentPassword, newPassword } = parsed.data;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, provider: true, password: true },
    });

    if (!user) return unauthorized(res);

    if (user.provider !== "LOCAL" || !user.password) {
      return forbidden(
        res,
        "Your account signs in with Google, so it has no password to change.",
      );
    }

    if (!(await verifyPassword(currentPassword, user.password))) {
      return badRequest(res, "Your current password is incorrect.");
    }

    if (currentPassword === newPassword) {
      return badRequest(
        res,
        "Your new password must be different from the current one.",
      );
    }

    const passwordHash = await hashPassword(newPassword);

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { password: passwordHash },
      });

      await revokeOtherSessions(userId, req, tx);
    });

    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true });

    void sendPasswordChangedEmail(user.email, user.name);
  } catch (error: any) {
    console.error("Change Password Error:", error);
    return serverError(res);
  }
};

export const checkEmail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = emailQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);

    const email = parsed.data.email.trim().toLowerCase();

    const match = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });

    if (match?.id === userId) {
      return badRequest(res, "This is already your email address.");
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({ success: true, available: match === null });
  } catch (error: any) {
    console.error("Check Email Error:", error);
    return serverError(res);
  }
};

export const requestEmailChange = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = requestEmailChangeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { email, password } = parsed.data;

    const normalizedEmail = email.trim().toLowerCase();

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, provider: true, password: true },
    });

    if (!user) return unauthorized(res);

    if (user.provider !== "LOCAL" || !user.password) {
      return forbidden(res, GOOGLE_EMAIL_ERROR);
    }

    const verify = await verifyPassword(password, user.password);

    if (!(await verifyPassword(password, user.password))) {
      return badRequest(res, "Your current password is incorrect.");
    }

    if (user.email.toLowerCase() === normalizedEmail) {
      return badRequest(res, "This is already your email address.");
    }

    if (await isEmailTaken(normalizedEmail, userId)) {
      return conflict(res, IN_USE_ERROR);
    }

    const code = generateVerificationCode();
    const now = new Date();
    const cutoff = new Date(now.getTime() - RESEND_COOLDOWN_MS);

    const claimed = await db.user.updateMany({
      where: {
        id: userId,
        OR: [
          { verificationLastSentAt: null },
          { verificationLastSentAt: { lte: cutoff } },
          { pendingEmail: null },
          { pendingEmail: { not: normalizedEmail } },
        ],
      },
      data: {
        verificationCode: hashVerificationCode(code),
        verificationCodeExpire: new Date(
          now.getTime() + VERIFICATION_CODE_TTL_MS,
        ),
        verificationAttempts: 0,
        verificationLastSentAt: now,
        pendingEmail: normalizedEmail,
        pendingEmailRequestedAt: now,
      },
    });

    if (claimed.count === 0) {
      return tooManyRequests(
        res,
        "A code was just sent to this address. Please wait a minute before requesting another.",
      );
    }

    try {
      await sendVerificationEmail(normalizedEmail, code);
    } catch (mailError) {
      console.error("Email change mail failed:", mailError);
      return mailFailed(res, userId);
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "A verification code has been sent to your new email address.",
      email: normalizedEmail,
    });
  } catch (error: any) {
    if (isUniqueViolation(error)) return conflict(res, IN_USE_ERROR);
    console.log("Request Email Change Error: ", error);
    return serverError(res);
  }
};

export const verifyEmailChange = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { email, code } = parsed.data;
    const normalizedEmail = email.trim().toLowerCase();

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        provider: true,
        pendingEmail: true,
        verificationCode: true,
        verificationCodeExpire: true,
      },
    });

    if (
      !user ||
      user.provider !== "LOCAL" ||
      !user.verificationCode ||
      !user.verificationCodeExpire ||
      user.verificationCodeExpire < new Date() ||
      user.pendingEmail?.toLowerCase() !== normalizedEmail
    ) {
      return badRequest(res, INVALID_CODE_ERROR);
    }

    const storedCode = user.verificationCode;

    const attempt = await db.user.updateMany({
      where: {
        id: userId,
        verificationAttempts: { lt: MAX_VERIFICATION_ATTEMPTS },
      },
      data: { verificationAttempts: { increment: 1 } },
    });

    if (attempt.count === 0) {
      return tooManyRequests(
        res,
        "Too many incorrect attempts. Please request a new code.",
      );
    }

    if (!isVerificationCodeValid(code, storedCode)) {
      return badRequest(res, INVALID_CODE_ERROR);
    }

    if (await isEmailTaken(normalizedEmail, userId)) {
      return conflict(res, IN_USE_ERROR);
    }

    const changed = await db.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: {
          id: userId,
          pendingEmail: normalizedEmail,
          verificationCode: storedCode,
        },
        data: {
          email: normalizedEmail,
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
          pendingEmail: null,
          pendingEmailRequestedAt: null,
          verificationCode: null,
          verificationCodeExpire: null,
          verificationAttempts: 0,
          verificationLastSentAt: null,
        },
      });

      if (result.count === 0) return false;

      await revokeOtherSessions(userId, req, tx);
      return true;
    });

    if (!changed) return badRequest(res, INVALID_CODE_ERROR);

    res.set("Cache-Control", "no-store");
    res.status(200).json({
      success: true,
      message: "Your email address has been updated.",
      email: normalizedEmail,
    });

    void sendEmailChangedNotice(user.email, normalizedEmail, user.name);
  } catch (error: any) {
    if (isUniqueViolation(error)) return conflict(res, IN_USE_ERROR);

    console.error("Verify Email Change Error:", error);
    return serverError(res);
  }
};

export const resendCode = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = resendCodeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const normalizedEmail = parsed.data.email.trim().toLowerCase();

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        provider: true,
        pendingEmail: true,
        verificationLastSentAt: true,
      },
    });

    if (!user) return unauthorized(res);

    if (user.provider !== "LOCAL") return forbidden(res, GOOGLE_EMAIL_ERROR);

    if (user.pendingEmail?.toLowerCase() !== normalizedEmail) {
      return badRequest(
        res,
        "There's no pending email change for this address. Please start again.",
      );
    }

    if (await isEmailTaken(normalizedEmail, userId)) {
      return conflict(res, IN_USE_ERROR);
    }

    const code = generateVerificationCode();
    const now = new Date();
    const cutoff = new Date(now.getTime() - RESEND_COOLDOWN_MS);

    const claimed = await db.user.updateMany({
      where: {
        id: userId,
        pendingEmail: normalizedEmail,
        OR: [
          { verificationLastSentAt: null },
          { verificationLastSentAt: { lte: cutoff } },
        ],
      },
      data: {
        verificationCode: hashVerificationCode(code),
        verificationCodeExpire: new Date(
          now.getTime() + VERIFICATION_CODE_TTL_MS,
        ),
        verificationAttempts: 0,
        verificationLastSentAt: now,
      },
    });

    if (claimed.count === 0) {
      const lastSent = user.verificationLastSentAt?.getTime() ?? now.getTime();
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - lastSent)) / 1000),
      );

      return tooManyRequests(
        res,
        `Please wait ${retryAfterSeconds} seconds before requesting a new code.`,
      );
    }

    try {
      await sendVerificationEmail(normalizedEmail, code);
    } catch (mailError) {
      console.error("Email change resend failed:", mailError);
      return mailFailed(res, userId);
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "A new verification code has been sent.",
      email: normalizedEmail,
    });
  } catch (error) {
    console.log("resend Code Error: ", error);
    return serverError(res);
  }
};
