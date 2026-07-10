import type { PrismaService } from '../prisma/prisma.service.js';

export interface LatestSizedHeight {
  heightCm: number;
  /** Whole days from the measurement to now, floored at 0. Drives `freshness` (spec E, A5.5). */
  heightAgeDays: number;
}

/**
 * The plant's most recent SIZE-BEARING progress entry, and how old it is.
 *
 * This is the single definition of "the plant's height" for the whole system: the care engine reads it
 * to compute the crowding index, the plant detail read model shows it, and the care read model decides
 * from its age whether the engine is actually using it. Three callers, one query — because the two
 * things that make it correct are conventions, not obvious facts, and a copy cannot keep them:
 *
 *  - a later NOTE-ONLY progress entry must never blank a real height (hence the `sizeCm: { not: null }`
 *    filter *before* the ordering), and
 *  - the tiebreak is `occurredOn desc, createdAt desc` — two entries recorded for the same day resolve
 *    by insertion order, so re-measuring a plant twice in one day takes the later reading.
 *
 * Age is measured from `occurredOn` (when the plant was measured), never `createdAt` (when it was typed
 * in), and floored at 0 so a future-dated entry reads as fully fresh rather than negative.
 */
export async function latestSizedHeight(
  prisma: Pick<PrismaService, 'plantProgressEntry'>,
  plantId: string,
  now: Date = new Date(),
): Promise<LatestSizedHeight | null> {
  const latest = await prisma.plantProgressEntry.findFirst({
    where: { plantId, sizeCm: { not: null } },
    orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    select: { sizeCm: true, occurredOn: true },
  });
  if (latest?.sizeCm == null) return null;
  return {
    heightCm: latest.sizeCm,
    heightAgeDays: Math.max(0, Math.floor((now.getTime() - latest.occurredOn.getTime()) / 86_400_000)),
  };
}
