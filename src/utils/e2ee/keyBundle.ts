import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../../config/db.js";

type Db = typeof db | Prisma.TransactionClient;

export const b64 = (max: number) =>
  z.string().min(1).max(max).regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "Invalid encoding.");

const wrapped = b64(1024);

export const keyBundleSchema = z.object({
  epoch: z.number().int().min(1).max(1_000_000),
  devices: z
    .array(z.object({ deviceId: z.uuid("Invalid device id."), wrappedKey: wrapped }))
    .min(1)
    .max(1500),
  accounts: z
    .array(z.object({ userId: z.uuid("Invalid user id."), wrappedKey: wrapped }))
    .max(100)
    .default([]),
});

export type KeyBundle = z.infer<typeof keyBundleSchema>;

export class E2eeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const sendE2eeError = (res: Response, error: unknown) => {
  if (!(error instanceof E2eeError)) return false;

  res.status(error.status).json({
    success: false,
    error: error.message,
    code: error.code,
    ...(error.details !== undefined && { details: error.details }),
  });
  return true;
};

export type Roster = {
  devices: { id: string; userId: string; publicKey: string }[];
  accounts: { userId: string; publicKey: string }[];
  unready: string[];
};

export const loadRoster = async (client: Db, conversationId: string): Promise<Roster> => {
  const members = await client.conversationParticipant.findMany({
    where: { conversationId, leftAt: null },
    select: {
      userId: true,
      user: {
        select: {
          accountPublicKey: true,
          devices: {
            where: { revokedAt: null, publicKey: { not: null } },
            select: { id: true, publicKey: true },
          },
        },
      },
    },
  });

  const roster: Roster = { devices: [], accounts: [], unready: [] };

  for (const member of members) {
    const { accountPublicKey, devices } = member.user;
    const ready = devices.filter((device) => device.publicKey !== null);

    if (ready.length === 0) roster.unready.push(member.userId);
    if (accountPublicKey) {
      roster.accounts.push({ userId: member.userId, publicKey: accountPublicKey });
    }

    for (const device of ready) {
      roster.devices.push({
        id: device.id,
        userId: member.userId,
        publicKey: device.publicKey as string,
      });
    }
  }

  return roster;
};

export const rosterDetails = (roster: Roster, currentEpoch: number) => ({
  nextEpoch: currentEpoch + 1,
  devices: roster.devices,
  accounts: roster.accounts,
});

const rotationRequired = (roster: Roster, currentEpoch: number) =>
  new E2eeError(
    409,
    "KEY_ROTATION_REQUIRED",
    "Chat keys need to be refreshed.",
    rosterDetails(roster, currentEpoch),
  );

const sameSet = (a: string[], b: string[]) => {
  const set = new Set(a);
  return set.size === a.length && set.size === b.length && b.every((id) => set.has(id));
};

export const checkSendEpoch = async (
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    actorId: string;
    deviceId: string;
    keyEpoch: number;
    keyBundle?: KeyBundle;
  },
) => {
  const { conversationId, actorId, deviceId, keyEpoch, keyBundle } = input;

  const sender = await tx.device.findFirst({
    where: { id: deviceId, userId: actorId, revokedAt: null, publicKey: { not: null } },
    select: { id: true },
  });

  if (!sender) {
    throw new E2eeError(409, "DEVICE_KEY_REQUIRED", "This device isn't set up for encryption yet.");
  }

  const conversation = await tx.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { type: true, keyEpoch: true, rekeyRequired: true },
  });
  const roster = await loadRoster(tx, conversationId);

  if (conversation.type === "DIRECT" && roster.unready.length > 0) {
    throw new E2eeError(
      409,
      "E2EE_NOT_READY",
      "They haven't opened Relay since encryption was added, so they can't receive encrypted messages yet.",
    );
  }

  if (keyBundle) {
    const exact =
      keyBundle.epoch === conversation.keyEpoch + 1 &&
      keyEpoch === keyBundle.epoch &&
      sameSet(keyBundle.devices.map((d) => d.deviceId), roster.devices.map((d) => d.id)) &&
      sameSet(keyBundle.accounts.map((a) => a.userId), roster.accounts.map((a) => a.userId));

    if (!exact) throw rotationRequired(roster, conversation.keyEpoch);

    const moved = await tx.conversation.updateMany({
      where: { id: conversationId, keyEpoch: conversation.keyEpoch },
      data: { keyEpoch: keyBundle.epoch, rekeyRequired: false },
    });

    if (moved.count === 0) {
      throw new E2eeError(409, "KEY_EPOCH_CONFLICT", "Chat keys changed. Please try again.");
    }

    await tx.conversationDeviceKey.createMany({
      data: keyBundle.devices.map((device) => ({
        conversationId,
        deviceId: device.deviceId,
        epoch: keyBundle.epoch,
        wrappedKey: device.wrappedKey,
      })),
    });

    if (keyBundle.accounts.length > 0) {
      await tx.conversationAccountKey.createMany({
        data: keyBundle.accounts.map((account) => ({
          conversationId,
          userId: account.userId,
          epoch: keyBundle.epoch,
          wrappedKey: account.wrappedKey,
        })),
      });
    }

    return;
  }

  if (conversation.keyEpoch === 0 || conversation.rekeyRequired) {
    throw rotationRequired(roster, conversation.keyEpoch);
  }

  if (keyEpoch !== conversation.keyEpoch) {
    throw new E2eeError(409, "KEY_EPOCH_STALE", "Chat keys changed. Please refresh and try again.");
  }

  const [deviceRows, accountRows] = await Promise.all([
    tx.conversationDeviceKey.findMany({
      where: { conversationId, epoch: conversation.keyEpoch },
      select: { deviceId: true },
    }),
    tx.conversationAccountKey.findMany({
      where: { conversationId, epoch: conversation.keyEpoch },
      select: { userId: true },
    }),
  ]);

  const coveredDevices = new Set(deviceRows.map((row) => row.deviceId));
  const coveredAccounts = new Set(accountRows.map((row) => row.userId));

  const uncovered =
    roster.devices.some((device) => !coveredDevices.has(device.id)) ||
    roster.accounts.some((account) => !coveredAccounts.has(account.userId));

  if (uncovered) throw rotationRequired(roster, conversation.keyEpoch);
};

export const markRekeyRequired = (tx: Prisma.TransactionClient, conversationId: string) =>
  tx.conversation.update({ where: { id: conversationId }, data: { rekeyRequired: true } });