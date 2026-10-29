import { Router } from "express";
import { signChatUpload, signStoryUpload } from "../controllers/uploadController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";

const uploadRouter = Router();

uploadRouter.use(verifyAuth);
uploadRouter.post("/chat/sign", signChatUpload);
uploadRouter.post("/story/sign", signStoryUpload);

export default uploadRouter;
