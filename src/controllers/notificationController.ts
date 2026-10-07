import { Prisma } from "@prisma/client";
import { Response, Request } from "express";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { notificationsQuerySchema } from "../validators/notificationValidator.js";
import { db } from "../config/db.js";

const unauthorized = (res: Response) =>
  res.status(401).json({
    success: false,
    error: "Access denied. No token provided.",
  });

const serverError = (res: Response) =>
  res.status(500).json({ success: false, error: "Something went wrong." });

const visibleWhere = (userId: string): Prisma.NotificationWhereInput => ({
  userId,
  OR: [{ friendshipId: null }, { friendship: { status: { not: "BLOCKED" } } }],
});

export const getNotifications = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return unauthorized(res);

    const queryResult = notificationsQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
      return res.status(400).json({
        success: false,
        error: queryResult.error.issues[0].message,
      });
    }

    const { cursor, limit } = queryResult.data;

    let where: Prisma.NotificationWhereInput = visibleWhere(userId);

    if (cursor) {
      const [iso, id] = cursor.split("_");
      const createdAt = new Date(iso);

      if (Number.isNaN(createdAt.getTime())) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid cursor." });
      }

      where = {
        AND: [
          visibleWhere(userId),
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: id } },
            ],
          },
        ],
      };
    }

    const rows = await db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        type: true,
        isRead: true,
        createdAt: true,
        actor: {
          select: { id: true, name: true, username: true, avatar: true },
        },
        friendship: { select: { id: true, status: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return res.status(200).json({
      success: true,
      items,
      nextCursor:
        hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    });
  } catch (error: any) {
    console.error("Get Notifications Error:", error);
    return serverError(res);
  }
};

export const getUnreadCount = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return unauthorized(res);

    const [count, pendingRequests] = await Promise.all([
      db.notification.count({
        where: { ...visibleWhere(userId), isRead: false },
      }),
      db.friendship.count({
        where: { receiverId: userId, status: "PENDING" },
      }),
    ]);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({ success: true, count, pendingRequests });
  } catch (error: any) {
    console.error("Get Unread Count Error:", error);
    return serverError(res);
  }
};

export const markAllRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return unauthorized(res);

    const result = await db.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    return res.status(200).json({ success: true, updated: result.count });
  } catch (error: any) {
    console.error("Mark All Read Error:", error);
    return serverError(res);
  }
};
