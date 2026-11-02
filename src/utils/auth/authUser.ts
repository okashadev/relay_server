import type { Prisma } from "@prisma/client";

export const authUserSelect = {
  id: true,
  name: true,
  username: true,
  email: true,
  avatar: true,
  bio: true,
  isEmailVerified: true,
  provider: true,
} satisfies Prisma.UserSelect;