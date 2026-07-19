import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { FeedbackService } from './feedback.service.js';
import { dayDiff, startOfTodayUtc } from '../common/time/local-date.js';
import { REPOT_ALPHA, REPOT_Q } from '../engines/adaptation.js';

const TZ = 'America/Mexico_City';

// Harness modeled on feedback.service.reason.test.ts, extended with the reads the REPOT flow makes:
// the plant profile (potSizeCm/growthHabit), the latest sized progress entry, and the place-city timezone.
function build(
  opts: {
    potSizeCm?: number | null;
    growthHabit?: string | null;
    sizeCm?: number | null;
    sizedOccurredOn?: Date | null;
    currentMultiplier?: number | null;
  } = {},
) {
  const created: any[] = [];
  const overrideUpserts: any[] = [];
  const overrideDeletes: any[] = [];
  const adjustmentUpserts: any[] = [];
  const prisma = {
    plant: {
      findFirst: async () => ({ id: 'pl1' }),
      findUniqueOrThrow: async () => ({
        acquiredOn: new Date('2025-01-01'),
        place: { city: { timezone: TZ } },
      }),
    },
    plantProfile: {
      findUnique: async () => ({
        potSizeCm: opts.potSizeCm ?? null,
        growthHabit: opts.growthHabit ?? null,
      }),
    },
    plantProgressEntry: {
      findFirst: async () =>
        opts.sizeCm != null
          ? { sizeCm: opts.sizeCm, occurredOn: opts.sizedOccurredOn ?? new Date() }
          : null,
    },
    careEvent: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        created.push(data);
      },
      count: async () => 0,
    },
    dueCache: { findUnique: async () => null },
    taskOverride: {
      count: async () => 0,
      deleteMany: async (a: any) => {
        overrideDeletes.push(a);
      },
      upsert: async (a: any) => {
        overrideUpserts.push(a);
      },
    },
    plantTaskAdjustment: {
      findUnique: async () =>
        opts.currentMultiplier != null ? { multiplier: opts.currentMultiplier } : null,
      upsert: async (a: any) => {
        adjustmentUpserts.push(a);
      },
    },
    plantWriteAudit: { create: async () => ({}) },
    $transaction: async (fn: any) => fn(prisma),
  } as any;
  const owner = { ownerFilter: () => ({}), currentOwnerId: () => 'owner-1', currentActor: () => ({ userId: 'u1' }) } as any;
  const carePlan = { recomputePlant: vi.fn(async () => {}) } as any;
  return {
    svc: new FeedbackService(prisma, owner, carePlan),
    created,
    overrideUpserts,
    overrideDeletes,
    adjustmentUpserts,
    carePlan,
  };
}

const payloadOf = (created: any[]) => created[0].payload as any;

describe('FeedbackService — REPOT inspection flow (spec F.3/F5.3/F.6)', () => {
  // ---- F1.2: the live production bug, fixed ----
  it('could-not-check leaves PlantTaskAdjustment UNCHANGED (the F1.2 fix — no multiplier write)', async () => {
    // Trap (a): the test MUST exercise a POSTPONED, which is what the old code gated adapt() on.
    // Trap (b): assert on the MULTIPLIER, not on dueCache — the override masks the damage until the next
    // DONE, so a dueCache assertion gives a false green.
    const { svc, adjustmentUpserts, overrideUpserts } = build({ currentMultiplier: 1 });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'could-not-check',
    });
    expect(adjustmentUpserts).toEqual([]);
    expect(overrideUpserts).toHaveLength(1); // it still writes a floor (remind tomorrow)
  });

  it('could-not-check does not move the multiplier even when one already exists (1.4 stays 1.4)', async () => {
    const { svc, adjustmentUpserts } = build({ currentMultiplier: 1.4 });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'could-not-check',
    });
    expect(adjustmentUpserts).toEqual([]);
  });

  it('a REPOT postpone with NO reason at all defaults to could-not-check and records nothing', async () => {
    const { svc, adjustmentUpserts, created } = build({ currentMultiplier: 1 });
    await svc.record({ plantId: 'pl1', task: 'REPOT', type: 'POSTPONED', occurredOn: new Date() });
    expect(payloadOf(created).reason).toBe('could-not-check');
    expect(adjustmentUpserts).toEqual([]);
  });

  it('a FOREIGN (WATER) reason on a REPOT postpone is defensively downgraded to could-not-check', async () => {
    const { svc, adjustmentUpserts, created } = build({ currentMultiplier: 1 });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'soil-still-moist',
    });
    expect(payloadOf(created).reason).toBe('could-not-check');
    expect(adjustmentUpserts).toEqual([]);
  });

  // ---- routing: no fresh height -> fallback -> the tracker runs on a JUSTIFIED reason ----
  it('needed-cannot-now with NO height routes to adjustment and SHORTENS the multiplier', async () => {
    const { svc, adjustmentUpserts, created } = build({ currentMultiplier: 1 }); // no sizeCm -> R_obs null
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'needed-cannot-now',
    });
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(payloadOf(created).R_obs).toBeNull();
    expect(adjustmentUpserts).toHaveLength(1);
    expect(adjustmentUpserts[0].update.multiplier).toBeCloseTo(Math.exp(-REPOT_ALPHA * (1 - REPOT_Q)), 12);
    expect(adjustmentUpserts[0].update.multiplier).toBeLessThan(1);
  });

  it('not-needed-yet with NO height routes to adjustment and LENGTHENS the multiplier', async () => {
    const { svc, adjustmentUpserts, created } = build({ currentMultiplier: 1 });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'not-needed-yet',
    });
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(adjustmentUpserts[0].update.multiplier).toBeCloseTo(Math.exp(REPOT_ALPHA * REPOT_Q), 12);
    expect(adjustmentUpserts[0].update.multiplier).toBeGreaterThan(1);
  });

  it('a fresh height with NO pot size routes to adjustment (R is not computable => wc = 0)', async () => {
    // Load-bearing (Spec E A5.4): reading `wc` as "staleness alone" would give this plant wc ~ 1 and
    // silently erase its learned adjustment in favour of a physical channel that does not exist.
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: null,
      growthHabit: 'upright',
      sizeCm: 60,
      sizedOccurredOn: new Date(),
      currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'needed-cannot-now',
    });
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(adjustmentUpserts).toHaveLength(1);
  });

  it('a trailing habit routes to adjustment (height is not the relevant dimension => no crowding signal)', async () => {
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20,
      growthHabit: 'trailing',
      sizeCm: 60,
      sizedOccurredOn: new Date(),
      currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'not-needed-yet',
    });
    expect(payloadOf(created).R_obs).toBeNull();
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(adjustmentUpserts).toHaveLength(1);
  });

  // ---- routing: fresh R_obs -> calibration -> the tracker does NOT run (exclusivity, F5.3) ----
  it('needed-cannot-now with a FRESH height + pot routes to calibration and writes NO adjustment', async () => {
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20,
      growthHabit: 'upright',
      sizeCm: 60,
      sizedOccurredOn: new Date(),
      currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'needed-cannot-now',
    });
    const p = payloadOf(created);
    expect(p.routedTo).toBe('calibration');
    expect(p.R_obs).toBeCloseTo(60 / 20 / 1.0, 6); // upright normalizer 1.0 -> R_obs = 3
    expect(typeof p.heightMeasuredOn).toBe('string'); // ISO snapshot persisted
    expect(p.heightCm).toBe(60); // the raw inputs ride along: growthHabit is user-editable
    expect(p.potSizeCm).toBe(20);
    expect(p.growthHabit).toBe('upright');
    expect(adjustmentUpserts).toEqual([]); // the calibration channel owns it; the fallback stays out
  });

  // ---- routing by FRESHNESS, not existence (F.6) ----
  it('a STALE height (age > 730 d) routes to adjustment even though R_obs exists', async () => {
    const old = new Date(Date.now() - 800 * 86_400_000);
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20,
      growthHabit: 'upright',
      sizeCm: 60,
      sizedOccurredOn: old,
      currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'needed-cannot-now',
    });
    expect(payloadOf(created).R_obs).toBeCloseTo(3, 6); // R_obs EXISTS...
    expect(payloadOf(created).routedTo).toBe('adjustment'); // ...but freshness routes it to the fallback
    expect(adjustmentUpserts).toHaveLength(1);
  });

  it('routing is on freshness >= ROUTE_MIN, not freshness > 0: a barely-fresh height takes the fallback', async () => {
    // freshness ramps linearly from 1 at day 90 to 0 at day 730. At day 600 it is 0.203 — well above zero,
    // far below ROUTE_MIN. Routing on `> 0` would send this to a channel where it has almost no authority
    // AND deny it the fallback, so it would contribute to neither.
    const age600 = new Date(Date.now() - 600 * 86_400_000);
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20, growthHabit: 'upright', sizeCm: 60, sizedOccurredOn: age600, currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1', task: 'REPOT', type: 'POSTPONED', occurredOn: new Date(), reason: 'not-needed-yet',
    });
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(adjustmentUpserts).toHaveLength(1);
  });

  it('at freshness 0.484 (age 420 d) it takes the fallback — just BELOW the threshold', async () => {
    // freshness(420) = (730-420)/(730-90) = 0.4844. Paired with the 410-day case below, this brackets
    // ROUTE_MIN to (0.4844, 0.5] — lowering it or raising it breaks one of the two. The bracket is what makes
    // the constant falsifiable rather than decorative.
    const age420 = new Date(Date.now() - 420 * 86_400_000);
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20, growthHabit: 'upright', sizeCm: 60, sizedOccurredOn: age420, currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1', task: 'REPOT', type: 'POSTPONED', occurredOn: new Date(), reason: 'not-needed-yet',
    });
    expect(payloadOf(created).routedTo).toBe('adjustment');
    expect(adjustmentUpserts).toHaveLength(1);
  });

  it('at freshness 0.500 exactly (age 410 d) it routes to calibration — the threshold is inclusive', async () => {
    // freshness(410) = 320/640 = 0.5 exactly. `>=` admits it. This is the boundary, and it is a real
    // threshold on a continuous curve, not a constant.
    const age410 = new Date(Date.now() - 410 * 86_400_000);
    const { svc, adjustmentUpserts, created } = build({
      potSizeCm: 20, growthHabit: 'upright', sizeCm: 60, sizedOccurredOn: age410, currentMultiplier: 1,
    });
    await svc.record({
      plantId: 'pl1', task: 'REPOT', type: 'POSTPONED', occurredOn: new Date(), reason: 'not-needed-yet',
    });
    expect(payloadOf(created).routedTo).toBe('calibration');
    expect(adjustmentUpserts).toEqual([]);
  });

  // ---- F6.4: not-needed-yet ALWAYS moves the date forward; the floor is a UTC-MIDNIGHT @db.Date ----
  it('not-needed-yet writes a UTC-midnight floor at today + MIN_PUSH_DAYS (14)', async () => {
    const { svc, overrideUpserts } = build();
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'not-needed-yet',
    });
    const floor = overrideUpserts[0].create.nextDueOn as Date;
    // Assert the invariant a @db.Date round-trip enforces: exactly UTC-midnight, no wall-clock remainder.
    // `Date.now() + N * day` would carry the current time-of-day and FAIL this (the MariaDB date rule).
    expect(floor.getTime() % 86_400_000).toBe(0);
    expect(dayDiff(floor, startOfTodayUtc(TZ))).toBe(14);
  });

  it('needed-cannot-now snoozes 14 days (UTC-midnight)', async () => {
    const { svc, overrideUpserts } = build();
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'needed-cannot-now',
    });
    const floor = overrideUpserts[0].create.nextDueOn as Date;
    expect(floor.getTime() % 86_400_000).toBe(0);
    expect(dayDiff(floor, startOfTodayUtc(TZ))).toBe(14);
  });

  it('could-not-check reminds tomorrow (UTC-midnight, today + 1)', async () => {
    const { svc, overrideUpserts } = build();
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'could-not-check',
    });
    const floor = overrideUpserts[0].create.nextDueOn as Date;
    expect(floor.getTime() % 86_400_000).toBe(0);
    expect(dayDiff(floor, startOfTodayUtc(TZ))).toBe(1);
  });

  it('a client-supplied postponeToOn is IGNORED for REPOT — the server owns the floor', async () => {
    const { svc, overrideUpserts } = build();
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      postponeToOn: new Date('2030-01-01'),
      reason: 'could-not-check',
    });
    const floor = overrideUpserts[0].create.nextDueOn as Date;
    expect(dayDiff(floor, startOfTodayUtc(TZ))).toBe(1); // tomorrow, not 2030
  });

  // ---- HTTP-edge guard: a REPOT SYMPTOM (or any non-DONE/POSTPONED type) is REJECTED, not persisted ----
  it('rejects a REPOT SYMPTOM with BadRequestException and writes NOTHING', async () => {
    const { svc, created, overrideUpserts, adjustmentUpserts, carePlan } = build();
    await expect(
      svc.record({ plantId: 'pl1', task: 'REPOT', type: 'SYMPTOM', occurredOn: new Date() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toEqual([]);
    expect(overrideUpserts).toEqual([]);
    expect(adjustmentUpserts).toEqual([]);
    expect(carePlan.recomputePlant).not.toHaveBeenCalled();
  });

  // ---- REPOT DONE: snapshot + clear override, NEVER a calibration observation (F.4 / F.10 item 4) ----
  it('a REPOT DONE clears the override, writes no adjustment, and carries routedTo="done"', async () => {
    const { svc, adjustmentUpserts, created, overrideDeletes, overrideUpserts } = build({
      potSizeCm: 20,
      growthHabit: 'upright',
      sizeCm: 60,
    });
    await svc.record({ plantId: 'pl1', task: 'REPOT', type: 'DONE', occurredOn: new Date() });
    expect(adjustmentUpserts).toEqual([]);
    expect(created[0].type).toBe('DONE');
    expect(payloadOf(created).routedTo).toBe('done'); // a DONE never feeds the calibration
    expect(payloadOf(created).routedTo).not.toBe('calibration');
    expect(payloadOf(created).reason).toBeUndefined(); // a DONE is not an inspection outcome
    expect(overrideDeletes).toHaveLength(1); // the floor lifts on the real repot
    expect(overrideUpserts).toEqual([]);
  });

  it('a REPOT DONE still snapshots R_obs for audit (but routedTo excludes it structurally)', async () => {
    const { svc, created } = build({ potSizeCm: 20, growthHabit: 'upright', sizeCm: 60 });
    await svc.record({ plantId: 'pl1', task: 'REPOT', type: 'DONE', occurredOn: new Date() });
    expect(payloadOf(created).R_obs).toBeCloseTo(3, 6);
  });

  it('a REPOT feedback always triggers a recompute', async () => {
    const { svc, carePlan } = build();
    await svc.record({
      plantId: 'pl1',
      task: 'REPOT',
      type: 'POSTPONED',
      occurredOn: new Date(),
      reason: 'not-needed-yet',
    });
    expect(carePlan.recomputePlant).toHaveBeenCalledWith('pl1');
  });
});
