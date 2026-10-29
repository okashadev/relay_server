import { db } from "../../config/db.js";
import { deleteStoryMedia } from "./media.js";

const GRACE_MS = 60 * 60 * 1000;
const BATCH = 100;
const INTERVAL_MS = 30 * 60 * 1000;

export const purgeExpiredStories = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - GRACE_MS);

  const stale = await db.story.findMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { deletedAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true, userId: true, mediaUrl: true },
  });

  if (stale.length === 0) return 0;

  await Promise.all(
    stale
      .filter((story) => story.mediaUrl)
      .map((story) => deleteStoryMedia(story.mediaUrl as string, story.userId)),
  );

  await db.story.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });

  return stale.length;
};

export const startStoryPurgeJob = () => {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;

    try {
      for (let round = 0; round < 10; round++) {
        if ((await purgeExpiredStories()) < BATCH) break;
      }
    } catch (error) {
      console.error("Story purge failed:", error);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void run(), INTERVAL_MS);
  const first = setTimeout(() => void run(), 10_000);

  interval.unref();
  first.unref();

  return () => {
    clearInterval(interval);
    clearTimeout(first);
  };
};
