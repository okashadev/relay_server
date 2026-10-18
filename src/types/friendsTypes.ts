export type Relationship = "NONE" | "REQUEST_SENT" | "REQUEST_RECEIVED" | "FRIENDS";

export type PublicUser = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  bio: string | null;
};

export type UserWithRelationship = PublicUser & {
  relationship: Relationship;
  friendshipId: string | null;
  isBlocked: boolean | null;
};