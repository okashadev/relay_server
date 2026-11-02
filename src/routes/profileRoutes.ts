import { Router } from "express";
import {
  checkUsername,
  signProfileAvatar,
  updateProfile,
} from "../controllers/profileController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";

const profileRouter = Router();

profileRouter.use(verifyAuth);

profileRouter.get("/username-available", checkUsername);
profileRouter.post("/avatar/sign", signProfileAvatar);
profileRouter.patch("/", updateProfile);

export default profileRouter;
