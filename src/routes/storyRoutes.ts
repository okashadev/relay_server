import { Router } from "express";
import {
  createStory,
  deleteStory,
  getStories,
  getStoryViewers,
  markStoryViewed,
  replyToStory,
} from "../controllers/storiesController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";
// import {
//   storyReadLimiter,
//   storyViewLimiter,
//   storyWriteLimiter,
// } from "../middlewares/rateLimiters.js";

const storyRouter = Router();

storyRouter.use(verifyAuth);

storyRouter.get("/", getStories);
storyRouter.post("/", createStory)
storyRouter.post("/:id/view", markStoryViewed);
storyRouter.get("/:id/viewers", getStoryViewers);

storyRouter.post("/:id/reply", replyToStory);
storyRouter.delete("/:id", deleteStory);

export default storyRouter;
