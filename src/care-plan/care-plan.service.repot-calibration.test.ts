import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

// Same fixture family as care-plan.service.feedback.test.ts: a low-drought fern, base 4, weather offline
// (no VPD signal), `repotting.typicalIntervalMonths: 36` -> a REPOT cadence of 1080 days. With no REPOT
// DONE events the anchor is `acquiredOn`. So ONLY crowding / calibration / adjustment can move the date.
const record = {
  scientificName: 'Test fern',
  commonNamesEn: ['Fern'],
  watering: { baseIntervalDays: 4, soilDrynessBeforeWatering: 'keep-moist', droughtTolerance: 'low', temperatureSensitivity: 'low', lightSensitivity: 'low', reduceInDormancy: false },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 40, idealPct: 60 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: false },
  repotting: { typicalIntervalMonths: 36, signs: ['Roots out of holes'] },
  maintenance: { pruning: 'Trim.', rotationDays: null, leafCleaningDays: null, commonPests: [] },
  nativeClimate: { description: 'Humid.', koppen: 'Af', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: { confidence: 'high', sources: [{ title: 'X', url: 'https://x.test', accessedAt: '2026-06-18' }] },
};

const ANCHOR = new Date('2025-01-01');
const CADENCE = 1080;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);
const todayIso = () => new Date().toISOString();

interface RepotEvent { type: string; occurredOn: Date; createdAt?: Date; payload: unknown }

function setupRepot(
  opts: {
    profile?: { potSizeCm?: number | null; growthHabit?: string | null } | null;
    sizedHeight?: { sizeCm: number; occurredOn: Date } | null;
    repotEvents?: RepotEvent[];
    overrides?: { task: string; nextDueOn: Date }[];
    adjustments?: { task: string; multiplier: number }[];
  } = {},
) {
  const dues: Record<string, Date> = {};
  const anchorOrderBys: unknown[] = [];
  const plant = {
    id: 'pl1',
    acquiredOn: ANCHOR,
    species: { record },
    place: { id: 'p1', indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', airflow: null, city: { id: 'c1', latitude: 10, longitude: 20, timezone: 'UTC' } },
    adjustments: opts.adjustments ?? [],
    overrides: opts.overrides ?? [],
    frequencies: [],
    profile: opts.profile ?? null,
  };
  const repotEvents = opts.repotEvents ?? [];
  const prisma = {
    plant: { findUniqueOrThrow: async () => plant },
    plantProgressEntry: { findFirst: async () => opts.sizedHeight ?? null },
    careEvent: {
      // The per-task last-DONE anchor. Discriminates on task/type exactly as real Prisma does.
      findFirst: async ({ where, orderBy }: any) => {
        if (where?.task === 'REPOT' && where?.type === 'DONE') {
          anchorOrderBys.push(orderBy);
          return [...repotEvents].reverse().find((e) => e.type === 'DONE') ?? null;
        }
        return null;
      },
      // Two `type: { in: [...] }` queries exist: the WATER feedback window and the REPOT inspection history.
      findMany: async ({ where }: any) => (where?.task === 'REPOT' ? repotEvents : []),
    },
    dueCache: {
      upsert: async ({ where, create, update }: any) => {
        dues[where.plantId_task.task] = create?.nextDueOn ?? update?.nextDueOn ?? null;
      },
      deleteMany: async () => {},
    },
  } as any;
  const svc = new CarePlanService(prisma, { forCity: async () => null } as any);
  return { svc, dues, anchorOrderBys };
}

// A fresh, computable current crowding: upright (normalizer 1.0), pot 20 cm, measured today -> R = sizeCm/20.
const freshProfile = { potSizeCm: 20, growthHabit: 'upright' };
const sizedToday = (sizeCm: number) => ({ sizeCm, occurredOn: new Date() });
const calibEvent = (reason: string, R: number): RepotEvent => ({
  type: 'POSTPONED',
  occurredOn: new Date(),
  payload: { routedTo: 'calibration', reason, R_obs: R, heightMeasuredOn: todayIso() },
});
const adjEvent = (reason: string, R: number): RepotEvent => ({
  type: 'POSTPONED',
  occurredOn: new Date(),
  payload: { routedTo: 'adjustment', reason, R_obs: R, heightMeasuredOn: todayIso() },
});

describe('F.4 — the REPOT anchor query carries the createdAt tiebreak', () => {
  it('orders by [occurredOn desc, createdAt desc], matching plants.service.ts', async () => {
    // `occurredOn` is @db.Date (day granularity), so two same-day REPOT DONE events TIE. Without the
    // tiebreak the winner — and thus which payload the calibration reads — is non-deterministic, and the
    // scheduling anchor can disagree with `derived.lastRepottedOn`.
    const { svc, anchorOrderBys } = setupRepot();
    await svc.recomputePlant('pl1');
    expect(anchorOrderBys).toContainEqual([{ occurredOn: 'desc' }, { createdAt: 'desc' }]);
  });
});

describe('REPOT calibration + floor wiring (spec F5.2b/F5.3/F6.0a/F3.1)', () => {
  it('BACKCOMPAT: a bare plant (no height, no pot, no events) is bit-for-bit the raw cadence', async () => {
    const bare = setupRepot();
    await bare.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, bare.dues.REPOT)).toBe(CADENCE);
  });

  it('BACKCOMPAT: legacy REPOT events (no reason, no routedTo) are ignored by the calibration', async () => {
    // Every REPOT CareEvent in the 2026-07-09 production dump looks like this. They must not move anything.
    const legacy = setupRepot({
      repotEvents: [
        { type: 'POSTPONED', occurredOn: new Date(), payload: {} },
        { type: 'POSTPONED', occurredOn: new Date(), payload: { adherence: { onTime: true } } },
      ],
    });
    await legacy.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, legacy.dues.REPOT)).toBe(CADENCE);
  });

  it('MECHANISM: a routedTo="adjustment" inspection is SKIPPED by the calibration; a routedTo="calibration" one is CONSUMED', async () => {
    // Same fresh current crowding (R = 46/20 = 2.3) in all three, so R_REF_plant is the ONLY difference.
    // Asserting the persisted FLAG's effect, not merely "something moved": an effect-only test passes while
    // the double count is live, because the calibration re-reads the history on every recompute.
    const baseline = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46) });
    const adjRouted = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46), repotEvents: [adjEvent('not-needed-yet', 2.6)] });
    const calibRouted = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46), repotEvents: [calibEvent('not-needed-yet', 2.6)] });
    await baseline.svc.recomputePlant('pl1');
    await adjRouted.svc.recomputePlant('pl1');
    await calibRouted.svc.recomputePlant('pl1');

    expect(daysBetween(ANCHOR, baseline.dues.REPOT)).toBe(962); // crowded -> earlier than the raw cadence
    expect(daysBetween(ANCHOR, adjRouted.dues.REPOT)).toBe(962); // the fallback-routed event never enters
    expect(daysBetween(ANCHOR, calibRouted.dues.REPOT)).toBe(1253); // the calibration-routed one does
  });

  it('a calibration-routed not-needed-yet raises R_REF_plant -> the same R reads as LESS crowded -> REPOT later', async () => {
    const bare = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46) });
    const calib = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46), repotEvents: [calibEvent('not-needed-yet', 2.6)] });
    await bare.svc.recomputePlant('pl1');
    await calib.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, calib.dues.REPOT)).toBeGreaterThan(daysBetween(ANCHOR, bare.dues.REPOT));
    expect(daysBetween(ANCHOR, calib.dues.REPOT)).toBeGreaterThan(CADENCE); // told it was early -> past cadence
  });

  it('a calibration-routed needed-cannot-now LOWERS R_REF_plant -> the same R reads as MORE crowded -> REPOT sooner', async () => {
    const bare = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46) });
    const calib = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46), repotEvents: [calibEvent('needed-cannot-now', 2.0)] });
    await bare.svc.recomputePlant('pl1');
    await calib.svc.recomputePlant('pl1');
    // The learner is bidirectional: without this direction it can only ever discover it was early.
    expect(daysBetween(ANCHOR, calib.dues.REPOT)).toBeLessThan(daysBetween(ANCHOR, bare.dues.REPOT));
  });

  // VACUOUS-TEST TRAP (found in plan review, kept as a warning). An earlier draft compared a no-event
  // baseline against one calibration event and asserted `> 1080`. It CANNOT FAIL for the property it claims:
  // an implementation that recomputes R_obs from the CURRENT profile (R = 40/20 = 2.0) also passes, because
  // a not-needed observation AT the prior still moves the posterior (est = 2.549). Verified:
  //   recompute-from-profile -> cfR(2.0, 2.549) = 1.16124 -> due 1254 > 1080   passes
  //   payload-driven         -> cfR(2.0, 3.503) = 1.18000 -> due 1274 > 1080   passes
  // Both pass; the assertion cannot distinguish them. The version below holds the profile FIXED and varies
  // ONLY the persisted payload, so the two implementations give different dates.
  it('F5.3: the calibration reads the PERSISTED payload R_obs, not the current profile', async () => {
    const atPrior = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(40), repotEvents: [calibEvent('not-needed-yet', 2.0)] });
    const aboveIt = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(40), repotEvents: [calibEvent('not-needed-yet', 3.5)] });
    await atPrior.svc.recomputePlant('pl1');
    await aboveIt.svc.recomputePlant('pl1');
    // Same profile, same height, same anchor — the ONLY difference is the payload R_obs.
    expect(daysBetween(ANCHOR, atPrior.dues.REPOT)).toBe(1254);
    expect(daysBetween(ANCHOR, aboveIt.dues.REPOT)).toBe(1274);
    expect(daysBetween(ANCHOR, atPrior.dues.REPOT)).not.toBe(daysBetween(ANCHOR, aboveIt.dues.REPOT));
  });

  it('F5.3: mutating potSizeCm AFTER the event does not move R_REF_plant (the snapshot property)', async () => {
    // Same persisted payload (R_obs = 3.5) in both, but the plant has since been potted up 20 -> 30 cm.
    // A payload-driven calibration yields the SAME R_REF_plant (3.503), and here the same clamped due.
    // An implementation that recomputed R_obs from the profile would get 2.0 vs 1.333, hence 1254 vs 1274.
    const before = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(40), repotEvents: [calibEvent('not-needed-yet', 3.5)] });
    const after = setupRepot({ profile: { ...freshProfile, potSizeCm: 30 }, sizedHeight: sizedToday(40), repotEvents: [calibEvent('not-needed-yet', 3.5)] });
    await before.svc.recomputePlant('pl1');
    await after.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, before.dues.REPOT)).toBe(daysBetween(ANCHOR, after.dues.REPOT));
    expect(daysBetween(ANCHOR, before.dues.REPOT)).toBe(1274);
  });

  it('F6.0a: a persisted adjustment=1.4 does NOT compound once a fresh height makes wc -> 1', async () => {
    const crowdedFresh = sizedToday(60); // R = 60/20 = 3 (crowded), measured today -> wc = 1
    const withAdj14 = setupRepot({ profile: freshProfile, sizedHeight: crowdedFresh, adjustments: [{ task: 'REPOT', multiplier: 1.4 }] });
    const withAdj10 = setupRepot({ profile: freshProfile, sizedHeight: crowdedFresh, adjustments: [{ task: 'REPOT', multiplier: 1.0 }] });
    await withAdj14.svc.recomputePlant('pl1');
    await withAdj10.svc.recomputePlant('pl1');
    // adjustment_effective = 1 + (1.4-1)(1-wc) -> 1.0 at wc = 1, so the two converge:
    expect(daysBetween(ANCHOR, withAdj14.dues.REPOT)).toBe(daysBetween(ANCHOR, withAdj10.dues.REPOT));
    expect(daysBetween(ANCHOR, withAdj14.dues.REPOT)).toBe(886);
    // Without the (1-wc) scaling the 1.4 would give 1240 — LENGTHENING the date on a visibly crowded plant.
    expect(daysBetween(ANCHOR, withAdj14.dues.REPOT)).toBeLessThan(CADENCE);
  });

  it('F6.0a: with NO height (wc = 0) the fallback multiplier keeps FULL authority', async () => {
    // The complement of the test above — otherwise `adjustment_effective` could be hardcoded to 1 and pass.
    const stale = setupRepot({ adjustments: [{ task: 'REPOT', multiplier: 1.4 }] });
    await stale.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, stale.dues.REPOT)).toBe(Math.round(CADENCE * 1.4)); // 1512
  });

  it('F3.1: an override (floor) never MASKS the engine — a different height still moves the REPOT date', async () => {
    const floorSoon = [{ task: 'REPOT', nextDueOn: new Date(ANCHOR.getTime() + 30 * 86_400_000) }];
    const rA = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(44), overrides: floorSoon }); // R = 2.2
    const rB = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(48), overrides: floorSoon }); // R = 2.4
    await rA.svc.recomputePlant('pl1');
    await rB.svc.recomputePlant('pl1');
    // Under the OLD pinning short-circuit both would be +30 d. Under the floor, max(computed, floor) = computed.
    expect(daysBetween(ANCHOR, rA.dues.REPOT)).toBe(1000);
    expect(daysBetween(ANCHOR, rB.dues.REPOT)).toBe(925);
    expect(daysBetween(ANCHOR, rA.dues.REPOT)).not.toBe(daysBetween(ANCHOR, rB.dues.REPOT));
  });

  it('F3.1: a could-not-check +1-day snooze floor never pins a far-future computed date', async () => {
    const tomorrow = [{ task: 'REPOT', nextDueOn: new Date(ANCHOR.getTime() + 86_400_000) }];
    const r = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(48), overrides: tomorrow });
    await r.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, r.dues.REPOT)).toBe(925); // due = max(computed, +1) = computed, NOT pinned at +1
  });

  it('F3.1: a floor LATER than the computed date does hold the date forward', async () => {
    // The other half of max(): a snooze must still be able to push a date out.
    const farFloor = [{ task: 'REPOT', nextDueOn: new Date(ANCHOR.getTime() + 1500 * 86_400_000) }];
    const r = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(48), overrides: farFloor });
    await r.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, r.dues.REPOT)).toBe(1500);
  });

  it('F3.1: a WATER override still REPLACES (the seam did not change non-REPOT semantics)', async () => {
    const early = new Date(ANCHOR.getTime() + 2 * 86_400_000);
    const r = setupRepot({ overrides: [{ task: 'WATER', nextDueOn: early }] });
    await r.svc.recomputePlant('pl1');
    expect(daysBetween(ANCHOR, r.dues.WATER)).toBe(2); // the owner's date wins, even though computed is later
  });

  it('F5.2b: a REPOT DONE carries the posterior forward — it does not reset R_REF_plant to R_REF', async () => {
    const doneOn = new Date(Date.now() - 400 * 86_400_000); // a repot ~1.1 y ago closed the first cycle
    const carried = setupRepot({
      profile: freshProfile,
      sizedHeight: sizedToday(46),
      repotEvents: [
        calibEvent('not-needed-yet', 2.6),
        calibEvent('needed-cannot-now', 3.8),
        { type: 'DONE', occurredOn: doneOn, payload: { routedTo: 'done', R_obs: 2.6 } },
      ],
    });
    // A plant with the SAME current crowding but no history at all: R_REF_plant = R_REF.
    const amnesia = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46) });
    await carried.svc.recomputePlant('pl1');
    await amnesia.svc.recomputePlant('pl1');
    // Both anchor on the DONE / acquiredOn respectively, so compare the *shape*: the carried plant's
    // threshold is still above R_REF, so it reads as LESS crowded and its due sits further from its anchor.
    expect(daysBetween(doneOn, carried.dues.REPOT)).toBeGreaterThan(daysBetween(ANCHOR, amnesia.dues.REPOT));
  });

  it('F.10 item 4: a REPOT DONE is NOT a calibration observation (routedTo="done" excludes it)', async () => {
    const doneOn = new Date(Date.now() - 100 * 86_400_000);
    const withDone = setupRepot({
      profile: freshProfile,
      sizedHeight: sizedToday(46),
      repotEvents: [{ type: 'DONE', occurredOn: doneOn, payload: { routedTo: 'done', R_obs: 2.0, reason: 'needed-cannot-now' } }],
    });
    await withDone.svc.recomputePlant('pl1');
    // The DONE re-anchors the cycle but contributes NO observation: the date is the bare-threshold date.
    // A preventive repot recorded as a `needed` observation would have pulled it in.
    const bare = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(46) });
    await bare.svc.recomputePlant('pl1');
    expect(daysBetween(doneOn, withDone.dues.REPOT)).toBe(daysBetween(ANCHOR, bare.dues.REPOT));
  });

  it('ROTATE / CLEAN_LEAVES are untouched by all of this (they share computeCadenceDue)', async () => {
    // The species has rotationDays/leafCleaningDays null, so both are cleared — and the REPOT machinery
    // must not have leaked into their branch. FERTILIZE is the live non-REPOT cadence check.
    const r = setupRepot({ profile: freshProfile, sizedHeight: sizedToday(60), adjustments: [{ task: 'REPOT', multiplier: 1.4 }] });
    await r.svc.recomputePlant('pl1');
    expect(r.dues.ROTATE).toBeUndefined();
    expect(r.dues.CLEAN_LEAVES).toBeUndefined();
    expect(r.dues.FERTILIZE).toBeDefined();
  });
});
