import { Router } from "express";
import { verifyAuth } from "../middlewares/authMiddleware.js";
import { createGroup } from "../controllers/groupController.js";

const groupRouter = Router();

groupRouter.use(verifyAuth);

groupRouter.post("/create", createGroup);

export default groupRouter;
