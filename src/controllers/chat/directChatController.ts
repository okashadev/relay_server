import { Response } from "express";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware.js";
import { getUserId } from "../../utils/getUserId.js";
import { unauthorized } from "../../utils/httpResponses.js";
import { newChatSchema } from "../../validators/directChatValidator.js";

export const newChat = async (req: AuthenticatedRequest, res: Response) => {
  const userId = getUserId(req);

  if (!userId) {
    return unauthorized(res);
  }

  const validationResult = newChatSchema.safeParse(req.body);

  if (!validationResult.success) {
    return
  }
};
