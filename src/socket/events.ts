export const SOCKET_EVENTS = {
  NOTIFICATION_NEW: "notification:new",
  FRIENDSHIP_UPDATED: "friendship:updated",
  MESSAGE_NEW: "message:new",
  MESSAGE_UPDATED: "message:updated",
  MESSAGE_REMOVED: "message:removed",
  RECEIPTS_UPDATED: "receipts:updated",
  PRESENCE_UPDATED: "presence:updated",
  TYPING_UPDATED: "typing:updated",
  CONVERSATION_SETTINGS: "conversation:settings",
  CONVERSATION_CLEARED: "conversation:cleared",
  BLOCK_UPDATED: "block:updated",
} as const;

export const CLIENT_EVENTS = {
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
} as const;
