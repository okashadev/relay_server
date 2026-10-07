import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import {
  getSuggestions,
  searchUser,
  sendFriendRequest,
  cancelFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  getFriends,
} from "../controllers/friendController.js";

const friendRouter = Router();

friendRouter.use(verifyAuth);

friendRouter.get("/", getFriends);
friendRouter.get("/suggestions", getSuggestions);
friendRouter.post("/request", sendFriendRequest);
friendRouter.get("/search", searchUser);
friendRouter.delete("/request/:id", cancelFriendRequest);
friendRouter.post("/request/:id/accept", acceptFriendRequest);
friendRouter.post("/request/:id/reject", rejectFriendRequest);

export default friendRouter;
