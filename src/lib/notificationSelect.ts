import { Prisma } from "@prisma/client";

export const notificationSelect = {
  id: true,
  type: true,
  isRead: true,
  createdAt: true,
  actor: {
    select: { id: true, name: true, username: true, avatar: true },
  },
  friendship: { select: { id: true, status: true } },
} satisfies Prisma.NotificationSelect;
