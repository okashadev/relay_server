import { Prisma } from "@prisma/client";

export const SEARCH_LIMIT = 15;
export const MAX_FRIENDS = 500;

export const publicUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true,
  bio: true,
} satisfies Prisma.UserSelect;

export const friendUserSelect = {
  ...publicUserSelect,
  status: true,
} satisfies Prisma.UserSelect;