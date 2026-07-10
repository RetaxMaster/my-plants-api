import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

// Spec E, Area A — the crowding index wired into recomputePlant. A 12-month repot cadence (360 days)
// keeps the arithmetic readable; the species is otherwise deliberately neutral.
const record = {
  scientificName: 'Test species',
  commonNamesEn: ['Test'],
  watering: { baseIntervalDays: 10, soilDrynessBeforeWatering: 'mostly-dry', droughtTolerance: 'medium', temperatureSensitivity: 'low', lightSensitivity: 'low', reduceInDormancy: false },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 30, idealPct: 45 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: false },
  repotting: { typicalIntervalMonths: 12, signs: ['Roots out of drainage holes'] },
  maintenance: { pruning: 'Trim.', rotationDays: null, leafCleaningDays: null, commonPests: [] },
  nativeClimate: { description: 'Dry.', koppen: 'Aw', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: { confidence: 'high', sources: [{ title: 'X', url: 'https://x.test', accessedAt: '2026-06-18' }] },
};

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
// Anchored relative to "now" on purpose: the residual window starts at the REPOT anchor (the last REPOT
// DONE, else acquiredOn), and `heightAgeDays` is measured from now. A fixed calendar acquiredOn would let
// the fixtures' events drift outside that window as real time passes.
const ACQUIRED = daysAgo(400);

type WaterEvent = { type: 'DONE' | 'POSTPONED' | 'SYMPTOM'; occurredOn: Date; payload: unknown };

interface Opts {
  profile?: Record<string, unknown> | null;
  /** The latest SIZE-bearing progress entry, or null for a plant that has never been measured. */
  sized?: { sizeCm: number; occurredOn: Date } | null;
  waterEvents?: WaterEvent[];
  /** A REPOT DONE event — becomes the repot anchor AND the residual window's lower bound. */
  lastRepotDone?: Date | null;
  frequencies?: { task: string; intervalDays: number }[];
}

function setup(opts: Opts) {
  const dues: Record<string, Date> = {};
  const waterEvents = opts.waterEvents ?? [];
  const plant = {
    id: 'pl1',
    acquiredOn: ACQUIRED,
    species: { record },
    place: { id: 'place1', indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', airflow: null, city: { id: 'c1', latitude: 10, longitude: 20, timezone: 'UTC' } },
    adjustments: [],
    overrides: [],
    frequencies: opts.frequencies ?? [],
    profile: opts.profile ?? null,
  };
  const prisma = {
    plant: { findUniqueOrThrow: async () => plant },
    plantProgressEntry: { findFirst: async () => opts.sized ?? null },
    careEvent: {
      // The per-task DONE anchor. Only REPOT ever has one in these fixtures.
      findFirst: async ({ where }: any) =>
        where.task === 'REPOT' && opts.lastRepotDone ? { occurredOn: opts.lastRepotDone } : null,
      // The watering-feedback window. `occurredOn.gt` is the residual window's lower bound (REPOT only).
      findMany: async ({ where }: any) => {
        const since: Date | undefined = where.occurredOn?.gt;
        return waterEvents
          .filter((e) => (since ? e.occurredOn > since : true))
          .sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime());
      },
    },
    dueCache: {
      upsert: async ({ where, create }: any) => { dues[where.plantId_task.task] = create?.nextDueOn ?? null; },
      deleteMany: async () => {},
    },
  } as any;
  const weather = { forCity: async () => null } as any; // offline → no real temp/humidity signal
  return { svc: new CarePlanService(prisma, weather), dues };
}

const CROWDED_PROFILE = { potType: null, potSizeCm: 20, windowDistance: null, growLight: null, hasDrainage: null, soilMix: null, growthHabit: 'upright', ageMonths: null, nearHeater: null };
const dry = (occurredOn: Date): WaterEvent => ({ type: 'DONE', occurredOn, payload: { reason: 'dry-soil' } });
const intuition = (occurredOn: Date): WaterEvent => ({ type: 'DONE', occurredOn, payload: { reason: 'intuition' } });

describe('WATER crowding wiring (spec A5.3)', () => {
  it('a fresh tall height shortens the WATER interval; no sized entry leaves it unchanged', async () => {
    const tall = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 90, occurredOn: daysAgo(0) } });
    await tall.svc.recomputePlant('pl1');
    const sizeless = setup({ profile: CROWDED_PROFILE, sized: null });
    await sizeless.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, tall.dues.WATER)).toBeLessThan(daysBetween(ACQUIRED, sizeless.dues.WATER));
  });

  it('BACKCOMPAT: a plant with a pot size and no height waters exactly as before the feature', async () => {
    const { svc, dues } = setup({ profile: CROWDED_PROFILE, sized: null });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.WATER)).toBe(10); // the plain species base interval
  });

  it('a STALE height (older than the hard-zero age) waters identically to no height at all', async () => {
    const stale = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 90, occurredOn: daysAgo(800) } });
    await stale.svc.recomputePlant('pl1');
    const none = setup({ profile: CROWDED_PROFILE, sized: null });
    await none.svc.recomputePlant('pl1');
    expect(stale.dues.WATER.getTime()).toBe(none.dues.WATER.getTime());
  });

  it('a fresh height with NO pot size leaves WATER unchanged (R is not computable)', async () => {
    const noPot = setup({ profile: { ...CROWDED_PROFILE, potSizeCm: null }, sized: { sizeCm: 90, occurredOn: daysAgo(0) } });
    await noPot.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, noPot.dues.WATER)).toBe(10);
  });
});

describe('REPOT two-channel wiring (spec A5.4)', () => {
  const CADENCE = 12 * 30; // typicalIntervalMonths × 30

  it('BACKCOMPAT: no height, no pot size, no justified watering feedback → repot date unchanged', async () => {
    const { svc, dues } = setup({ profile: null, sized: null });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBe(CADENCE);
  });

  it('a fresh crowded height pulls the REPOT date IN (earlier)', async () => {
    const crowded = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 90, occurredOn: daysAgo(0) } });
    await crowded.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, crowded.dues.REPOT)).toBeLessThan(CADENCE);
  });

  it('a roomy plant pushes the REPOT date OUT (later)', async () => {
    const roomy = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 20, occurredOn: daysAgo(0) } }); // R = 1
    await roomy.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, roomy.dues.REPOT)).toBeGreaterThan(CADENCE);
  });

  it('a fresh height with NO pot size gives wc = 0 — the repot date must not move (A5.4, load-bearing)', async () => {
    // This is the case Spec F §F6.0a reads `wc` for. If `wc` were read as staleness alone it would be ~1
    // here, silently erasing the learned adjustment in favour of a physical channel that does not exist.
    const { svc, dues } = setup({ profile: { ...CROWDED_PROFILE, potSizeCm: null }, sized: { sizeCm: 90, occurredOn: daysAgo(0) } });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBe(CADENCE);
  });

  it('a TRAILING habit gives no crowding signal even with a fresh height and a pot size', async () => {
    const { svc, dues } = setup({ profile: { ...CROWDED_PROFILE, growthHabit: 'trailing' }, sized: { sizeCm: 90, occurredOn: daysAgo(0) } });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBe(CADENCE);
  });

  it('a STALE height gives wc = 0 — the repot date is the bare cadence again', async () => {
    const { svc, dues } = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 90, occurredOn: daysAgo(800) } });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBe(CADENCE);
  });

  it('justified dry-soil watering feedback alone pulls the REPOT date IN (the measured residual)', async () => {
    const { svc, dues } = setup({ profile: null, sized: null, waterEvents: [dry(daysAgo(3)), dry(daysAgo(9)), dry(daysAgo(15))] });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBeLessThan(CADENCE);
  });

  it('CONFOUND: an UNJUSTIFIED early-water (intuition) does NOT move the REPOT date', async () => {
    const { svc, dues } = setup({ profile: null, sized: null, waterEvents: [intuition(daysAgo(3)), intuition(daysAgo(9)), intuition(daysAgo(15))] });
    await svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, dues.REPOT)).toBe(CADENCE);
  });

  it('the residual window RESETS at a REPOT DONE: pre-repot dry-soil events are ignored', async () => {
    const repotOn = daysAgo(30);
    const preRepotEvidence = [dry(daysAgo(60)), dry(daysAgo(70)), dry(daysAgo(80))];

    // Same evidence, but a repot happened after it: the window starts at the repot, so it is empty.
    const afterRepot = setup({ profile: null, sized: null, waterEvents: preRepotEvidence, lastRepotDone: repotOn });
    await afterRepot.svc.recomputePlant('pl1');
    expect(daysBetween(repotOn, afterRepot.dues.REPOT)).toBe(CADENCE);

    // Without the repot, the very same events DO pull the date in — so the reset is what did the work.
    const noRepot = setup({ profile: null, sized: null, waterEvents: preRepotEvidence });
    await noRepot.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, noRepot.dues.REPOT)).toBeLessThan(CADENCE);
  });

  it('the PlantTaskFrequency seam still overrides the REPOT cadence', async () => {
    const bare = setup({ profile: null, sized: null, frequencies: [{ task: 'REPOT', intervalDays: 300 }] });
    await bare.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, bare.dues.REPOT)).toBe(300);

    // ...and crowding rides on top of the override rather than replacing it.
    const crowded = setup({ profile: CROWDED_PROFILE, sized: { sizeCm: 90, occurredOn: daysAgo(0) }, frequencies: [{ task: 'REPOT', intervalDays: 300 }] });
    await crowded.svc.recomputePlant('pl1');
    expect(daysBetween(ACQUIRED, crowded.dues.REPOT)).toBeLessThan(300);
  });
});
