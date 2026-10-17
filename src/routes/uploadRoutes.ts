import { Router } from "express";
import { signChatUpload } from "../controllers/uploadController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";

const uploadRouter = Router();

uploadRouter.use(verifyAuth);
uploadRouter.post("/chat/sign", signChatUpload);

export default uploadRouter;