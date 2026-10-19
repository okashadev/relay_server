import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import {
  blockUser,
  getBlockedUsers,
  unblockUser,
} from "../controllers/blockController.js";

const blockRouter = Router();

blockRouter.use(verifyAuth);

blockRouter.get("/", getBlockedUsers);
blockRouter.post("/", blockUser);
blockRouter.delete("/:userId", unblockUser);

export default blockRouter;
