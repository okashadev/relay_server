import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import {
  newChat,
  getMessages,
  getConversation,
  getChatsList,
  markConversationRead
} from "../controllers/ConversationController.js";

const conversationRouter = Router();

conversationRouter.get("/", verifyAuth, getChatsList);
conversationRouter.post("/:id/read", verifyAuth, markConversationRead);
conversationRouter.post("/direct/new-chat", verifyAuth, newChat);
conversationRouter.get("/:id", verifyAuth, getConversation);
conversationRouter.get("/:id/messages", verifyAuth, getMessages);


export default conversationRouter;
