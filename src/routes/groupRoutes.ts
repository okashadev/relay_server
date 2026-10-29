import { Router } from "express";
import {
  addMembers,
  createGroup,
  leaveGroup,
  removeMember,
  setMemberRole,
  signGroupAvatarUpload,
  updateGroup,
} from "../controllers/groupController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";

const groupRouter = Router();

groupRouter.use(verifyAuth);

groupRouter.post("/", createGroup);
groupRouter.patch("/:id", updateGroup);
groupRouter.post("/:id/avatar/sign", signGroupAvatarUpload);
groupRouter.post("/:id/members", addMembers);
groupRouter.delete("/:id/members/:memberId", removeMember);
groupRouter.patch("/:id/members/:memberId/role", setMemberRole);
groupRouter.post("/:id/leave", leaveGroup);

export default groupRouter;
