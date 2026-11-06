import type { Request } from "express";
import { db } from "../../config/db.js";
import { hashToken } from "../tokens.js";
import { REFRESH_COOKIE } from "./sessions.js";
import { emitToUser } from "../../socket/socketServer.js";
import { SOCKET_EVENTS } from "../../socket/events.js";

const MAX_DEVICES = 10;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux|X11/, "Linux"],
];

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) || null : null;

const describeDevice = (req: Request) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const agent = (req.get("user-agent") ?? "").slice(0, 300);

  const platform =
    body.platform === "ios" || body.platform === "android"
      ? body.platform
      : "web";
  const browser =
    clean(body.browser, 40) ??
    BROWSERS.find(([re]) => re.test(agent))?.[1] ??
    null;
  const os =
    clean(body.os, 40) ?? SYSTEMS.find(([re]) => re.test(agent))?.[1] ?? null;
  const deviceModel = clean(body.deviceModel, 60);

  const composed =
    platform === "web"
      ? [browser, os].filter(Boolean).join(" on ")
      : [deviceModel, os].filter(Boolean).join(" · ");

  return {
    name: clean(body.deviceName, 60) ?? (composed || "Unknown device"),
    platform,
    browser,
    os,
    deviceModel,
    appVersion: clean(body.appVersion, 20),
    userAgent: agent || null,
    ip: req.ip?.slice(0, 64) ?? null,
  };
};

export const revokeDevices = async (userId: string, deviceIds: string[]) => {
  if (deviceIds.length === 0) return;

  await db.$transaction([
    db.refreshToken.deleteMany({
      where: { userId, deviceId: { in: deviceIds } },
    }),
    db.conversationDeviceKey.deleteMany({
      where: { deviceId: { in: deviceIds } },
    }),
    db.device.updateMany({
      where: { userId, id: { in: deviceIds } },
      data: { revokedAt: new Date() },
    }),
    db.conversation.updateMany({
      where: { participants: { some: { userId, leftAt: null } } },
      data: { rekeyRequired: true },
    }),
  ]);

  emitToUser(userId, SOCKET_EVENTS.DEVICE_REVOKED, { deviceIds });
};

const trimDevices = async (userId: string) => {
  try {
    const stale = await db.device.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
      skip: MAX_DEVICES,
      select: { id: true },
    });

    if (stale.length === 0) return;

    const ids = stale.map((device) => device.id);

    await revokeDevices(userId, ids);
  } catch (error) {
    console.error("Trim devices failed:", error);
  }
};

export const registerDevice = async (userId: string, req: Request) => {
  const details = describeDevice(req);
  const requested = (req.body as { deviceId?: unknown } | undefined)?.deviceId;

  if (typeof requested === "string" && UUID_RE.test(requested)) {
    const reused = await db.device.updateMany({
      where: { id: requested, userId, revokedAt: null },
      data: { ...details, lastActiveAt: new Date() },
    });

    if (reused.count > 0) return { id: requested };
  }

  const created = await db.device.create({
    data: { userId, ...details },
    select: { id: true },
  });

  void trimDevices(userId);
  return created;
};

export const currentDeviceId = async (req: Request) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw !== "string" || !raw) return null;

  const row = await db.refreshToken.findUnique({
    where: { token: hashToken(raw) },
    select: { deviceId: true },
  });

  return row?.deviceId ?? null;
};
