import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db } from "../config/db.js";
import { Response } from "express";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_DAYS = 7;
const REFRESH_MAX_AGE = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
};

const flagCookieOptions = {
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export const generateAccessToken = (user: { id: string; email: string }) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET is not defined");

  return jwt.sign({ userId: user.id, email: user.email }, jwtSecret, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};

export const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

export const createRefreshToken = async (userId: string) => {
  const rawToken = crypto.randomBytes(64).toString("hex");

  await db.refreshToken.create({
    data: {
      token: hashToken(rawToken),
      userId,
      expiresAt: new Date(Date.now() + REFRESH_MAX_AGE),
    },
  });

  return rawToken;
};

export const setRefreshCookie = (res: Response, rawToken: string) => {
  res.cookie("refreshToken", rawToken, {
    ...cookieOptions,
    maxAge: REFRESH_MAX_AGE,
  });
  res.cookie("relay_session", "1", {
    ...flagCookieOptions,
    maxAge: REFRESH_MAX_AGE,
  });
};

export const clearRefreshCookie = (res: Response) => {
  res.clearCookie("refreshToken", cookieOptions);
  res.clearCookie("relay_session", flagCookieOptions);
};
