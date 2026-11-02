import { Router } from "express";
import { getMedia, getMediaSummary } from "../controllers/mediaController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";

const mediaRouter = Router();

mediaRouter.use(verifyAuth);

mediaRouter.get("/summary", getMediaSummary);
mediaRouter.get("/", getMedia);

export default mediaRouter;
