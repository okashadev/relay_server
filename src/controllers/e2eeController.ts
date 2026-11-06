import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../config/db.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { verifyPassword } from "../utils/auth/password.js";
import { getUserId } from "../utils/getUserId.js";
import { getInvitableIds } from "../utils/group/groupHelpers.js";
import {
  E2eeError,
  loadRoster,
  rosterDetails,
  sendE2eeError,
} from "../utils/e2ee/keyBundle.js";
import {
  badRequest,
  notFound,
  serverError,
  unauthorized,
  validationError,
} from "../utils/httpResponses.js";
import { conversationIdParamSchema } from "../validators/chatValidator.js";
import {
  accountKeysSchema,
  conversationKeysQuerySchema,
  deviceKeySchema,
  disableBackupSchema,
  publicKeysSchema,
  resetAccountSchema,
  setupAccountSchema,
  updateBackupSchema,
} from "../validators/e2eeValidator.js";
import {
  escrowOpen,
  escrowSeal,
  publicKeyFromSecret,
} from "../utils/e2ee/escrow.js";

type BackupInput = {
  data: string;
  salt: string;
  kdf: "argon2id";
  kdfParams: { m: number; t: number; p: number };
};

const backupFields = (backup: BackupInput) => {
  const bytes = Uint8Array.from(Buffer.from(backup.data, "base64"));

  return {
    data: bytes,
    salt: backup.salt,
    kdf: backup.kdf,
    kdfParams: backup.kdfParams as Prisma.InputJsonValue,
    version: 1,
    sizeBytes: bytes.length,
  };
};

const keepReset = async (userId: string): Promise<Record<string, string>> => {
  const row = await db.keyBackup.findUnique({
    where: { userId },
    select: { kdfParams: true },
  });
  const resetAt = (row?.kdfParams as { resetAt?: string } | null)?.resetAt;

  return resetAt ? { resetAt } : {};
};

const serverRow = (
  userId: string,
  secretKey: string,
  kdfParams: Record<string, string> = {},
) => {
  const data = escrowSeal(secretKey, userId);

  return {
    data,
    salt: "-",
    kdf: "server-v1",
    kdfParams: kdfParams as Prisma.InputJsonValue,
    version: 1,
    sizeBytes: data.length,
  };
};

const fail = (res: Response, error: unknown, label: string) => {
  if (sendE2eeError(res, error)) return;

  console.error(`${label}:`, error);
  return serverError(res);
};

const pairMatches = (secretKey: string, publicKey: string) =>
  publicKeyFromSecret(secretKey) === publicKey;

export const getE2eeStatus = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountPublicKey: true, keyBackup: { select: { kdf: true } } },
    });

    if (!user) return unauthorized(res);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      accountPublicKey: user.accountPublicKey,
      mode: !user.keyBackup
        ? "NONE"
        : user.keyBackup.kdf === "server-v1"
          ? "SERVER"
          : "PASSPHRASE",
    });
  } catch (error: any) {
    return fail(res, error, "E2EE Status Error");
  }
};

export const registerDeviceKey = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = deviceKeySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { deviceId, publicKey } = parsed.data;

    const device = await db.device.findFirst({
      where: { id: deviceId, userId, revokedAt: null },
      select: { publicKey: true },
    });

    if (!device) return notFound(res, "Device not found.");

    if (device.publicKey) {
      if (device.publicKey === publicKey)
        return res.status(200).json({ success: true });

      throw new E2eeError(
        409,
        "DEVICE_KEY_LOCKED",
        "This device already has a different encryption key.",
      );
    }

    const claimed = await db.device.updateMany({
      where: { id: deviceId, userId, publicKey: null },
      data: { publicKey, keyRegisteredAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new E2eeError(
        409,
        "DEVICE_KEY_LOCKED",
        "This device already has an encryption key.",
      );
    }

    res.set("Cache-Control", "no-store");
    return res.status(201).json({ success: true });
  } catch (error: any) {
    return fail(res, error, "Register Device Key Error");
  }
};

export const setupAccount = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = setupAccountSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { accountPublicKey, accountSecretKey } = parsed.data;

    if (!pairMatches(accountSecretKey, accountPublicKey)) {
      return badRequest(res, "The key pair doesn't match.");
    }

    await db.$transaction(async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: userId, accountPublicKey: null },
        data: { accountPublicKey },
      });

      if (claimed.count === 0) {
        throw new E2eeError(
          409,
          "ACCOUNT_ALREADY_SETUP",
          "Encryption is already set up.",
        );
      }

      await tx.keyBackup.create({
        data: { userId, ...serverRow(userId, accountSecretKey) },
      });
    });

    res.set("Cache-Control", "no-store");
    return res.status(201).json({ success: true });
  } catch (error: any) {
    return fail(res, error, "E2EE Setup Error");
  }
};

export const uploadAccountKeys = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = accountKeysSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const [user, backup] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { accountPublicKey: true },
      }),
      db.keyBackup.findUnique({
        where: { userId },
        select: { kdfParams: true },
      }),
    ]);

    if (!user?.accountPublicKey) {
      throw new E2eeError(
        409,
        "ACCOUNT_NOT_SET",
        "Encryption isn't set up yet.",
      );
    }

    const ids = [...new Set(parsed.data.keys.map((key) => key.conversationId))];

    const mine = await db.conversationParticipant.findMany({
      where: { userId, conversationId: { in: ids } },
      select: {
        conversationId: true,
        conversation: { select: { keyEpoch: true } },
      },
    });

    const maxEpoch = new Map(
      mine.map((row) => [row.conversationId, row.conversation.keyEpoch]),
    );

    let rows = parsed.data.keys.filter(
      (key) => key.epoch <= (maxEpoch.get(key.conversationId) ?? 0),
    );

    const resetAt = (backup?.kdfParams as { resetAt?: string } | null)?.resetAt;

    if (resetAt && rows.length > 0) {
      const fresh = await db.conversationDeviceKey.findMany({
        where: {
          conversationId: { in: ids },
          createdAt: { gt: new Date(resetAt) },
        },
        distinct: ["conversationId", "epoch"],
        select: { conversationId: true, epoch: true },
      });

      const allowed = new Set(
        fresh.map((row) => `${row.conversationId}:${row.epoch}`),
      );
      rows = rows.filter((key) =>
        allowed.has(`${key.conversationId}:${key.epoch}`),
      );
    }

    if (rows.length > 0) {
      await db.conversationAccountKey.createMany({
        data: rows.map((key) => ({ userId, ...key })),
        skipDuplicates: true,
      });
    }

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true, saved: rows.length });
  } catch (error: any) {
    return fail(res, error, "Upload Account Keys Error");
  }
};

export const getBackup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const row = await db.keyBackup.findUnique({
      where: { userId },
      select: {
        data: true,
        salt: true,
        kdf: true,
        kdfParams: true,
        version: true,
        user: { select: { accountPublicKey: true } },
      },
    });

    res.set("Cache-Control", "no-store");

    if (!row || !row.user.accountPublicKey) {
      return res.status(200).json({ success: true, mode: "NONE" });
    }

    if (row.kdf === "server-v1") {
      return res.status(200).json({
        success: true,
        mode: "SERVER",
        accountPublicKey: row.user.accountPublicKey,
        accountSecretKey: escrowOpen(row.data, userId),
      });
    }

    return res.status(200).json({
      success: true,
      mode: "PASSPHRASE",
      accountPublicKey: row.user.accountPublicKey,
      backup: {
        data: Buffer.from(row.data).toString("base64"),
        salt: row.salt,
        kdf: row.kdf,
        kdfParams: row.kdfParams,
        version: row.version,
      },
    });
  } catch (error: any) {
    return fail(res, error, "Get Backup Error");
  }
};

export const updateBackup = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = updateBackupSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const extra = await keepReset(userId);

    const updated = await db.keyBackup.updateMany({
      where: { userId },
      data: {
        ...backupFields(parsed.data.backup),
        kdfParams: {
          ...parsed.data.backup.kdfParams,
          ...extra,
        } as Prisma.InputJsonValue,
      },
    });

    if (updated.count === 0)
      return notFound(res, "Encryption isn't set up yet.");

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return fail(res, error, "Update Backup Error");
  }
};

export const disableBackup = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = disableBackupSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountPublicKey: true, keyBackup: { select: { kdf: true } } },
    });

    if (!user?.keyBackup || user.keyBackup.kdf === "server-v1") {
      return badRequest(res, "Passphrase protection is already off.");
    }

    if (
      !user.accountPublicKey ||
      !pairMatches(parsed.data.accountSecretKey, user.accountPublicKey)
    ) {
      return badRequest(res, "Incorrect key.");
    }

    await db.keyBackup.update({
      where: { userId },
      data: serverRow(
        userId,
        parsed.data.accountSecretKey,
        await keepReset(userId),
      ),
    });

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return fail(res, error, "Disable Backup Error");
  }
};

export const resetAccount = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = resetAccountSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const { accountPublicKey, accountSecretKey, password } = parsed.data;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        provider: true,
        password: true,
        keyBackup: { select: { kdf: true } },
      },
    });

    if (!user) return unauthorized(res);

    if (user.keyBackup?.kdf !== "argon2id") {
      return badRequest(res, "Passphrase protection isn't on.");
    }

    if (user.provider === "LOCAL") {
      if (
        !password ||
        !user.password ||
        !(await verifyPassword(password, user.password))
      ) {
        return badRequest(res, "Your password is incorrect.");
      }
    }

    if (!pairMatches(accountSecretKey, accountPublicKey)) {
      return badRequest(res, "The key pair doesn't match.");
    }

    await db.$transaction([
      db.conversationAccountKey.deleteMany({ where: { userId } }),
      db.user.update({ where: { id: userId }, data: { accountPublicKey } }),
      db.keyBackup.update({
        where: { userId },
        data: serverRow(userId, accountSecretKey, {
          resetAt: new Date().toISOString(),
        }),
      }),
    ]);

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return fail(res, error, "E2EE Reset Error");
  }
};

export const getPublicKeys = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const parsed = publicKeysSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const ids = [...new Set(parsed.data.userIds)].filter((id) => id !== userId);

    const [friendIds, coMembers, blocks] = await Promise.all([
      getInvitableIds(userId, ids),
      db.conversationParticipant.findMany({
        where: {
          userId: { in: ids },
          leftAt: null,
          conversation: { participants: { some: { userId, leftAt: null } } },
        },
        select: { userId: true },
      }),
      db.block.findMany({
        where: {
          OR: [
            { blockerId: userId, blockedId: { in: ids } },
            { blockedId: userId, blockerId: { in: ids } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
    ]);

    const blocked = new Set(
      blocks.map((block) =>
        block.blockerId === userId ? block.blockedId : block.blockerId,
      ),
    );

    const allowed = [
      ...new Set([...friendIds, ...coMembers.map((m) => m.userId)]),
    ].filter((id) => !blocked.has(id));

    const users = await db.user.findMany({
      where: { id: { in: [userId, ...allowed] } },
      select: {
        id: true,
        devices: {
          where: { revokedAt: null, publicKey: { not: null } },
          orderBy: { createdAt: "asc" },
          select: { id: true, publicKey: true },
        },
      },
    });

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      users: users.map((user) => ({
        id: user.id,
        devices: user.devices.flatMap((device) =>
          device.publicKey
            ? [{ id: device.id, publicKey: device.publicKey }]
            : [],
        ),
      })),
    });
  } catch (error: any) {
    return fail(res, error, "Get Public Keys Error");
  }
};

export const getConversationKeys = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const queryResult = conversationKeysQuerySchema.safeParse(req.query);
    if (!queryResult.success) return validationError(res, queryResult.error);

    const { id: conversationId } = paramsResult.data;
    const { deviceId } = queryResult.data;

    const [participant, device] = await Promise.all([
      db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversation: { select: { keyEpoch: true } } },
      }),
      db.device.findFirst({
        where: { id: deviceId, userId, revokedAt: null },
        select: { id: true },
      }),
    ]);

    if (!participant || !device)
      return notFound(res, "Conversation not found.");

    const [deviceKeys, accountKeys] = await Promise.all([
      db.conversationDeviceKey.findMany({
        where: { conversationId, deviceId },
        orderBy: { epoch: "asc" },
        take: 500,
        select: { epoch: true, wrappedKey: true },
      }),
      db.conversationAccountKey.findMany({
        where: { conversationId, userId },
        orderBy: { epoch: "asc" },
        take: 500,
        select: { epoch: true, wrappedKey: true },
      }),
    ]);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      keyEpoch: participant.conversation.keyEpoch,
      deviceKeys,
      accountKeys,
    });
  } catch (error: any) {
    return fail(res, error, "Get Conversation Keys Error");
  }
};

export const getRotationInfo = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = getUserId(req);
    if (!userId) return unauthorized(res);

    const paramsResult = conversationIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) return validationError(res, paramsResult.error);

    const { id: conversationId } = paramsResult.data;

    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { leftAt: true, conversation: { select: { keyEpoch: true } } },
    });

    if (!participant || participant.leftAt)
      return notFound(res, "Conversation not found.");

    const roster = await loadRoster(db, conversationId);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      keyEpoch: participant.conversation.keyEpoch,
      ...rosterDetails(roster, participant.conversation.keyEpoch),
    });
  } catch (error: any) {
    return fail(res, error, "Get Rotation Info Error");
  }
};
