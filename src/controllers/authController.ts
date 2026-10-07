import { sendVerificationEmail } from "../lib/email.js";
import { OAuth2Client } from "google-auth-library";
import { Request, Response } from "express";
import { db } from "../config/db.js";
import bcrypt from "bcrypt";
import {
  loginSchema,
  registerSchema,
  verifyEmailSchema,
  resendCodeSchema,
} from "../validators/authValidator.js";
import {
  clearRefreshCookie,
  createRefreshToken,
  generateAccessToken,
  hashToken,
  setRefreshCookie,
} from "../utils/tokens.js";
import {
  generateVerificationCode,
  hashVerificationCode,
  isVerificationCodeValid,
  MAX_VERIFICATION_ATTEMPTS,
  VERIFICATION_CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
} from "../utils/generateVerificationCode.js";

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "postmessage",
);

const INVALID_CODE_ERROR = "Invalid or expired code.";
const RESEND_MESSAGE =
  "If this email is awaiting verification, a new code has been sent.";

export const register = async (req: Request, res: Response) => {
  try {
    const validationResult = registerSchema.safeParse(req.body);

    if (!validationResult.success) {
      const errorMessage = validationResult.error.issues[0].message;
      return res.status(400).json({
        success: false,
        error: errorMessage,
      });
    }
    const { name, username, email, password } = validationResult.data;

    const existingUser = await db.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
      select: {
        id: true,
        email: true,
        username: true,
        provider: true,
        isEmailVerified: true,
        verificationLastSentAt: true,
      },
    });

    const reclaimable =
      existingUser !== null &&
      existingUser.email === email &&
      existingUser.provider === "LOCAL" &&
      !existingUser.isEmailVerified;

    if (existingUser && !reclaimable) {
      const field = existingUser.email === email ? "Email" : "Username";
      return res.status(400).json({
        success: false,
        error: `${field} already exists.`,
      });
    }

    if (reclaimable) {
      const lastSent = existingUser.verificationLastSentAt?.getTime() ?? 0;
      const waitMs = RESEND_COOLDOWN_MS - (Date.now() - lastSent);

      if (waitMs > 0) {
        return res.status(429).json({
          success: false,
          error: `Please wait ${Math.ceil(waitMs / 1000)} seconds before trying again.`,
        });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const verificationCode = generateVerificationCode();

    const verificationData = {
      verificationCode: hashVerificationCode(verificationCode),
      verificationCodeExpire: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      verificationAttempts: 0,
      verificationLastSentAt: new Date(),
    };

    const user = reclaimable
      ? await db.user.update({
          where: { id: existingUser.id },
          data: {
            name,
            username,
            password: hashedPassword,
            ...verificationData,
          },
          select: { id: true, email: true },
        })
      : await db.user.create({
          data: {
            name,
            username,
            email,
            password: hashedPassword,
            ...verificationData,
          },
          select: { id: true, email: true },
        });

    try {
      await sendVerificationEmail(user.email, verificationCode);
    } catch (emailError) {
      await db.user
        .delete({ where: { id: user.id } })
        .catch((cleanupError) =>
          console.error("Cleanup failed:", cleanupError),
        );

      return res.status(502).json({
        success: false,
        error: "We couldn't send the verification email. Please try again.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Account created. Please verify your email.",
      email: user.email,
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(400).json({
        success: false,
        error: "Email or username already exists.",
      });
    }

    console.error("Register Error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Something went wrong." });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const validationResult = loginSchema.safeParse(req.body);

    if (!validationResult.success) {
      const errorMessage = validationResult.error.issues[0].message;
      return res.status(400).json({
        success: false,
        error: errorMessage,
      });
    }

    const { email, password } = validationResult.data;

    const user = await db.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password!",
      });
    }

    if (user.provider === "GOOGLE") {
      return res.status(400).json({
        success: false,
        error: "This account uses Google sign-in. Please continue with Google.",
        code: "USE_GOOGLE_LOGIN",
      });
    }

    if (!user.password) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password!",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password!",
      });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        error: "Please verify your email before logging in.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

    return res.status(200).json({
      success: true,
      message: "Login successful!",
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
        email: user.email,
        isEmailVerified: user.isEmailVerified,
      },
    });
  } catch (error: any) {
    console.error("Login Error:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong.",
    });
  }
};

export const googleAuth = async (req: Request, res: Response) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Google code is required",
      });
    }

    const t0 = Date.now();
    const step = (label: string) =>
      console.log(`[google] ${label} +${Date.now() - t0}ms`);

    step("request aayi");

    let payload;
    try {
      step("exchange shuru");
      const { tokens } = await client.getToken(code);
      step("exchange mukammal");

      if (!tokens.id_token) {
        throw new Error("No id_token received from Google");
      }

      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
      step("verify mukammal");
    } catch (err: any) {
      console.error("Google code exchange error:", err);
      return res.status(401).json({
        success: false,
        error: "Google authentication failed",
      });
    }

    if (!payload || !payload.email) {
      return res.status(400).json({
        success: false,
        error: "Invalid Google token payload",
      });
    }

    if (!payload.email_verified) {
      return res.status(400).json({
        success: false,
        error: "Google email is not verified",
      });
    }

    const { email, name, picture } = payload;

    let user = await db.user.findUnique({
      where: { email },
    });

    step("db find mukammal");

    if (user && user.provider === "LOCAL") {
      return res.status(409).json({
        success: false,
        error:
          "An account with this email already exists. Please login with your email and password.",
        code: "USE_PASSWORD_LOGIN",
      });
    }

    if (!user) {
      const baseUsername =
        email
          .split("@")[0]
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "user";
      let uniqueUsername = baseUsername;

      let existingUser = await db.user.findUnique({
        where: { username: uniqueUsername },
      });

      while (existingUser) {
        uniqueUsername = `${baseUsername}${Math.floor(1000 + Math.random() * 9000)}`;
        existingUser = await db.user.findUnique({
          where: { username: uniqueUsername },
        });
      }

      user = await db.user.create({
        data: {
          name: name || "Google User",
          username: uniqueUsername,
          email,
          password: null,
          provider: "GOOGLE",
          avatar: picture || null,
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });

      step("db create mukammal");

    }

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

    step("response bhej raha hun");
    return res.status(200).json({
      success: true,
      message: "Google Authentication successful",
      token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
        isEmailVerified: user.isEmailVerified,
      },
    });
  } catch (error: any) {
    console.error("Google Login Error:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong.",
    });
  }
};

export const refresh = async (req: Request, res: Response) => {
  try {
    const rawToken = req.cookies?.refreshToken;

    if (!rawToken) {
      clearRefreshCookie(res);
      return res.status(401).json({
        success: false,
        error: "No refresh token.",
      });
    }

    const stored = await db.refreshToken.findUnique({
      where: {
        token: hashToken(rawToken),
      },
      include: {
        user: true,
      },
    });

    if (!stored) {
      clearRefreshCookie(res);
      return res.status(401).json({
        success: false,
        error: "Invalid refresh token.",
      });
    }

    if (stored.expiresAt < new Date()) {
      await db.refreshToken.deleteMany({ where: { id: stored.id } });
      clearRefreshCookie(res);
      return res.status(401).json({
        success: false,
        error: "Session expired. Please login again.",
      });
    }

    const deleted = await db.refreshToken.deleteMany({
      where: {
        id: stored.id,
      },
    });

    if (deleted.count === 0) {
      return res.status(401).json({
        success: false,
        error: "Refresh token already used.",
      });
    }

    const newRefreshToken = await createRefreshToken(stored.userId);
    const accessToken = generateAccessToken(stored.user);

    setRefreshCookie(res, newRefreshToken);

    return res.status(200).json({
      success: true,
      token: accessToken,
      user: {
        id: stored.user.id,
        name: stored.user.name,
        username: stored.user.username,
        email: stored.user.email,
        avatar: stored.user.avatar,
        isEmailVerified: stored.user.isEmailVerified,
      },
    });
  } catch (error: any) {
    console.error("Refresh Error:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong.",
    });
  }
};

export const logout = async (req: Request, res: Response) => {
  try {
    const rawToken = req.cookies?.refreshToken;

    if (rawToken) {
      await db.refreshToken.deleteMany({
        where: { token: hashToken(rawToken) },
      });
    }

    clearRefreshCookie(res);

    return res.status(200).json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (error: any) {
    console.error("Logout Error:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong.",
    });
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const validationResult = verifyEmailSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: validationResult.error.issues[0].message,
      });
    }

    const { email, code } = validationResult.data;

    const user = await db.user.findUnique({
      where: {
        email,
      },
    });

    if (
      !user ||
      user.provider !== "LOCAL" ||
      user.isEmailVerified ||
      !user.verificationCode ||
      !user.verificationCodeExpire ||
      user.verificationCodeExpire < new Date()
    ) {
      return res
        .status(400)
        .json({ success: false, error: INVALID_CODE_ERROR });
    }

    const attempt = await db.user.updateMany({
      where: {
        id: user.id,
        verificationAttempts: { lt: MAX_VERIFICATION_ATTEMPTS },
      },
      data: { verificationAttempts: { increment: 1 } },
    });

    if (attempt.count === 0) {
      return res.status(429).json({
        success: false,
        error: "Too many incorrect attempts. Please request a new code.",
      });
    }

    if (!isVerificationCodeValid(code, user.verificationCode)) {
      return res
        .status(400)
        .json({ success: false, error: INVALID_CODE_ERROR });
    }

    const verifiedUser = await db.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        verificationCode: null,
        verificationCodeExpire: null,
        verificationAttempts: 0,
        verificationLastSentAt: null,
      },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        avatar: true,
        isEmailVerified: true,
      },
    });

    const accessToken = generateAccessToken(verifiedUser);
    const refreshToken = await createRefreshToken(verifiedUser.id);
    setRefreshCookie(res, refreshToken);

    return res.status(200).json({
      success: true,
      message: "Email verified successfully.",
      token: accessToken,
      user: verifiedUser,
    });
  } catch (error: any) {
    console.error("Verify Email Error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Something went wrong." });
  }
};

export const resendVerificationCode = async (req: Request, res: Response) => {
  try {
    const validationResult = resendCodeSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: validationResult.error.issues[0].message,
      });
    }

    const { email } = validationResult.data;

    const user = await db.user.findUnique({
      where: {
        email,
      },
      select: {
        id: true,
        email: true,
        provider: true,
        isEmailVerified: true,
        verificationLastSentAt: true,
      },
    });

    if (!user || user.provider !== "LOCAL" || user.isEmailVerified) {
      return res.status(200).json({ success: true, message: RESEND_MESSAGE });
    }

    const verificationCode = generateVerificationCode();
    const cutoff = new Date(Date.now() - RESEND_COOLDOWN_MS);

    const claimed = await db.user.updateMany({
      where: {
        id: user.id,
        OR: [
          { verificationLastSentAt: null },
          { verificationLastSentAt: { lte: cutoff } },
        ],
      },
      data: {
        verificationCode: hashVerificationCode(verificationCode),
        verificationCodeExpire: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        verificationAttempts: 0,
        verificationLastSentAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      const lastSent = user.verificationLastSentAt?.getTime() ?? Date.now();
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastSent)) / 1000),
      );

      return res.status(429).json({
        success: false,
        error: `Please wait ${retryAfterSeconds} seconds before requesting a new code.`,
        retryAfterSeconds,
      });
    }

    try {
      await sendVerificationEmail(user.email, verificationCode);
    } catch (emailError) {
      console.error("Resend email failed:", emailError);
      return res.status(502).json({
        success: false,
        error: "We couldn't send the email. Please try again in a minute.",
      });
    }

    return res.status(200).json({ success: true, message: RESEND_MESSAGE });
  } catch (error: any) {
    console.error("Resend Code Error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Something went wrong." });
  }
};
