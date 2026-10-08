import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt, { type JwtPayload } from "jsonwebtoken";

let io: Server | null = null;

export const userRoom = (userId: string) => `user:${userId}`;

const authError = (code: string) => {
  const error = new Error("Authentication failed") as Error & {
    data: { code: string };
  };

  error.data = { code };
  return error;
};

export const initSocketServer = (httpServer: HttpServer): Server => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined");

  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || token.length === 0) {
      return next(authError("NO_TOKEN"));
    }

    try {
      const decoded = jwt.verify(token, secret, {
        algorithms: ["HS256"],
      }) as JwtPayload;

      if (typeof decoded.userId !== "string") {
        return next(authError("INVALID_TOKEN"));
      }

      socket.data.userId = decoded.userId;
      return next();
    } catch (error: any) {
      return next(
        authError(
          error instanceof jwt.TokenExpiredError
            ? "TOKEN_EXPIRED"
            : "INVALID_TOKEN",
        ),
      );
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    socket.join(userRoom(userId));

    if (process.env.NODE_ENV !== "production") {
      console.log(`[socket] connected ${userId} (${socket.id})`);
      socket.on("disconnect", (reason) =>
        console.log(`[socket] disconnected ${userId}: ${reason}`),
      );
    }
  });

  return io;
};

export const emitToUser = (userId: string, event: string, payload: unknown) => {
  try {
    io?.to(userRoom(userId)).emit(event, payload);
  } catch (error: any) {
    console.error("Socket emit failed:", error);
  }
};

export const closeSocketServer = (): Promise<void> =>
  new Promise((resolve) => {
    if (!io) return resolve();

    const server = io;
    io = null;
    server.close(() => resolve());
  });
