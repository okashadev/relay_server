import { Request, Response } from "express";
import { loginSchema, registerSchema } from "../validators/authValidator.js";
import { db } from "../config/db.js";
import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import {
  clearRefreshCookie,
  createRefreshToken,
  generateAccessToken,
  hashToken,
  setRefreshCookie,
} from "../utils/tokens.js";

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "postmessage",
);

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
      select: { email: true, username: true },
    });

    if (existingUser) {
      const field = existingUser.email === email ? "Email" : "Username";
      return res.status(400).json({
        success: false,
        error: `${field} already exists.`,
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = await db.user.create({
      data: {
        name,
        username,
        email,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        createdAt: true,
        isEmailVerified: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Account Created Successfully.",
      user: newUser,
    });
  } catch (error: any) {
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

    let payload;
    try {
      const { tokens } = await client.getToken(code);

      if (!tokens.id_token) {
        throw new Error("No id_token received from Google");
      }

      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
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
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);
    setRefreshCookie(res, refreshToken);

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
