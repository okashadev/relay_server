import type { Response } from "express";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { currentDeviceId, revokeDevices } from "../utils/auth/devices.js";
import { getUserId } from "../utils/getUserId.js";
import {
  badRequest,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { deviceParamSchema } from "../validators/e2eeValidator.js";

export const listDevices = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const [current, devices] = await Promise.all([
      currentDeviceId(req),
      db.device.findMany({
        where: {
          userId,
          revokedAt: null,
          refreshTokens: { some: { expiresAt: { gt: new Date() } } },
        },
        orderBy: { lastActiveAt: "desc" },
        take: 20,
        select: {
          id: true,
          name: true,
          platform: true,
          browser: true,
          os: true,
          deviceModel: true,
          appVersion: true,
          ip: true,
          publicKey: true,
          lastActiveAt: true,
          createdAt: true,
        },
      }),
    ]);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      devices: devices.map(({ publicKey, ...device }) => ({
        ...device,
        encrypted: publicKey !== null,
        isCurrent: device.id === current,
      })),
    });
  } catch (error: any) {
    console.error("List Devices Error:", error);
    return serverError(res);
  }
};

export const revokeDevice = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = deviceParamSchema.safeParse(req.params);
    if (!parsed.success) return validationError(res, parsed.error);

    const { id } = parsed.data;

    if (id === (await currentDeviceId(req))) {
      return badRequest(
        res,
        "This is the device you're using. Log out instead.",
      );
    }

    const device = await db.device.findFirst({
      where: { id, userId, revokedAt: null },
      select: { id: true },
    });

    if (!device) return notFound(res, "Device not found.");

    await revokeDevices(userId, [id]);

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("Revoke Device Error:", error);
    return serverError(res);
  }
};

export const revokeOtherDevices = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const current = await currentDeviceId(req);
    if (!current)
      return badRequest(
        res,
        "Couldn't identify this device. Please sign in again.",
      );

    const others = await db.device.findMany({
      where: { userId, revokedAt: null, id: { not: current } },
      select: { id: true },
      take: 50,
    });

    await revokeDevices(
      userId,
      others.map((device) => device.id),
    );

    return res.status(200).json({ success: true, revoked: others.length });
  } catch (error: any) {
    console.error("Revoke Other Devices Error:", error);
    return serverError(res);
  }
};
