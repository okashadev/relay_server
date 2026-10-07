import { Router } from "express";
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
} from "../controllers/notificationController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";
// import { notificationsLimiter } from "../middlewares/rateLimiters.js";

const notificationRouter = Router();

notificationRouter.use(verifyAuth);

notificationRouter.get("/", getNotifications);
notificationRouter.get("/unread-count", getUnreadCount);
notificationRouter.post("/read-all", markAllRead);

export default notificationRouter;