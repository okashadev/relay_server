import { Response } from "express";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { getUserId } from "../utils/getUserId.js";
import { serverError, unauthorized } from "../utils/httpResponses.js";
import { getPresenceSnapshot } from "../utils/presence.js";

export const getPresence = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const users = await getPresenceSnapshot(userId);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({ success: true, users });
  } catch (error: any) {
    console.error("Get Presence Error:", error);
    return serverError(res);
  }
};
