import type { Prisma } from "@prisma/client";

export const authUserSelect = {
  id: true,
  name: true,
  username: true,
  email: true,
  avatar: true,
  bio: true,
  provider: true,
  isEmailVerified: true,
  accountPublicKey: true,
} satisfies Prisma.UserSelect;

export type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>;

export const toAuthUser = (user: AuthUser): AuthUser => ({
  id: user.id,
  name: user.name,
  username: user.username,
  email: user.email,
  avatar: user.avatar,
  bio: user.bio,
  provider: user.provider,
  isEmailVerified: user.isEmailVerified,
  accountPublicKey: user.accountPublicKey,
});