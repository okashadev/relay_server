import { NextFunction, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

export const verifyAuth = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Access denied. No token provided.",
      code: "NO_TOKEN",
    });
  }

  const token = authHeader.split(" ")[1];

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not defined in environment variables.");
    return res.status(500).json({
      success: false,
      error: "Something went wrong.",
    });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
    }) as JwtPayload;

    if (
      typeof decoded.userId !== "string" ||
      typeof decoded.email !== "string"
    ) {
      return res.status(401).json({
        success: false,
        error: "Invalid token payload.",
        code: "INVALID_TOKEN",
      });
    }

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch (error: any) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        success: false,
        error: "Token expired.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({
      success: false,
      error: "Invalid token.",
      code: "INVALID_TOKEN",
    });
  }
};
