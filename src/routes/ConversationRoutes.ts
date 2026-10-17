import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import {
  newChat,
  getMessages,
  getConversation,
  getChatsList,
  markConversationRead,
  sendMessage,
  updateChatSettings,
} from "../controllers/ConversationController.js";
import {
  deleteMessage,
  editMessage,
  removeReaction,
  setReaction,
} from "../controllers/messageActionsController.js";

const conversationRouter = Router();

conversationRouter.use(verifyAuth);

conversationRouter.get("/", getChatsList);
conversationRouter.get("/:id", getConversation);
conversationRouter.post("/:id/read", markConversationRead);
conversationRouter.post("/direct/new-chat", newChat);

conversationRouter.get("/:id/messages", getMessages);
conversationRouter.post("/:id/messages", sendMessage);
conversationRouter.patch("/:id/messages/:messageId", editMessage);
conversationRouter.delete("/:id/messages/:messageId", deleteMessage);

conversationRouter.patch("/:id/settings", updateChatSettings);

conversationRouter.put("/:id/messages/:messageId/reaction", setReaction);
conversationRouter.delete("/:id/messages/:messageId/reaction", removeReaction);

export default conversationRouter;
