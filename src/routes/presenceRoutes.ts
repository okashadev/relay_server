import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import { getPresence } from "../controllers/presenceController.js";

const presenceRouter = Router();

presenceRouter.use(verifyAuth);

presenceRouter.get("/", getPresence);

export default presenceRouter;
