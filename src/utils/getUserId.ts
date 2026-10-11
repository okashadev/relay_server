import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";

export const getUserId = (req: AuthenticatedRequest) => {
  return req.user?.userId;
};
