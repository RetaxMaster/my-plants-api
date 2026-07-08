import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

// Canonical VALID record (same fixture as Task 2). Base WATER interval 14, rotationDays 30,
// leafCleaningDays 30, misting default 'avoid' (→ no mist task). parseSpeciesRecord backfills defaults;
// do NOT hand-trim (a miscased/partial record fails Zod .parse). Anchor = acquiredOn 2026-07-06 (Mon),
// no care events. Tests that need a skipped optional task clone this and null the relevant field.
const record = {
  scientificName: 'Dracaena trifasciata',
  commonNamesEn: ['Snake plant'],
  watering: { baseIntervalDays: 14, soilDrynessBeforeWatering: 'mostly-dry', droughtTolerance: 'high', temperatureSensitivity: 'low', lightSensitivity: 'low', reduceInDormancy: true },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 30, idealPct: 45 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: true },
  repotting: { typicalIntervalMonths: 36, signs: ['Roots out of drainage holes'] },
  maintenance: { pruning: 'Remove damaged leaves.', rotationDays: 30, leafCleaningDays: 30, commonPests: ['mealybugs'] },
  nativeClimate: { description: 'West African dry tropics.', koppen: 'Aw', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: { confidence: 'high', sources: [{ title: 'RHS', url: 'https://www.rhs.org.uk/plants/dracaena', accessedAt: '2026-06-18' }] },
};

function setup(frequencies: { task: string; intervalDays: number }[], recordOverride: any = record) {
  const upserts: { task: string; nextDueOn: Date }[] = [];
  const cleared: string[] = [];
  const prisma = {
    plant: {
      findUniqueOrThrow: async () => ({
        id: 'p1', acquiredOn: d('2026-07-06'),
        species: { record: recordOverride }, // object, as Prisma returns a Json column
        place: { indoor: true, climateControlled: false, humidityCharacter: 'NORMAL', indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', city: { id: 'c1', latitude: 19, longitude: -99, timezone: 'UTC' } },
        adjustments: [], overrides: [], frequencies,
      }),
    },
    careEvent: { findFirst: async () => null, findMany: async () => [] },
    dueCache: {
      upsert: async ({ create }: any) => { upserts.push({ task: create.task, nextDueOn: create.nextDueOn }); },
      deleteMany: async ({ where }: any) => { cleared.push(where.task); },
    },
  } as any;
  const weather = { forCity: async () => null } as any;
  return { svc: new CarePlanService(prisma, weather), upserts, cleared };
}

describe('recomputePlant — frequency override substitution', () => {
  it('WATER override moves the due to ~anchor + override interval (clamp centered on the override)', async () => {
    const noOverride = setup([]);
    await noOverride.svc.recomputePlant('p1');
    const baseWater = noOverride.upserts.find((u) => u.task === 'WATER')!.nextDueOn; // ~anchor + 14

    const withOverride = setup([{ task: 'WATER', intervalDays: 21 }]);
    await withOverride.svc.recomputePlant('p1');
    const overWater = withOverride.upserts.find((u) => u.task === 'WATER')!.nextDueOn;

    // The override lengthens the cadence: the overridden due is strictly later than the species-base due.
    expect(overWater.getTime()).toBeGreaterThan(baseWater.getTime());
    // With neutral conditions (no weather signal, no adjustment) it lands ~21 days after the anchor.
    const days = Math.round((overWater.getTime() - d('2026-07-06').getTime()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(18);
    expect(days).toBeLessThanOrEqual(24);
  });

  it('ROTATE override changes the applicable rotation cadence (exact: pure cadence)', async () => {
    const base = setup([]);
    await base.svc.recomputePlant('p1');
    const baseRotate = base.upserts.find((u) => u.task === 'ROTATE')!.nextDueOn; // anchor + 30

    const over = setup([{ task: 'ROTATE', intervalDays: 45 }]);
    await over.svc.recomputePlant('p1');
    const overRotate = over.upserts.find((u) => u.task === 'ROTATE')!.nextDueOn; // anchor + 45
    expect(overRotate.getTime()).toBeGreaterThan(baseRotate.getTime());
    expect(Math.round((overRotate.getTime() - d('2026-07-06').getTime()) / 86_400_000)).toBe(45);
  });

  it('an override on a SKIPPED optional task (CLEAN_LEAVES = null) is INERT: no due row, still cleared', async () => {
    const skipLeaf = { ...record, maintenance: { ...record.maintenance, leafCleaningDays: null } };
    const { svc, upserts, cleared } = setup([{ task: 'CLEAN_LEAVES', intervalDays: 10 }], skipLeaf);
    await svc.recomputePlant('p1');
    expect(upserts.some((u) => u.task === 'CLEAN_LEAVES')).toBe(false);
    expect(cleared).toContain('CLEAN_LEAVES');
  });

  it('an override on a SKIPPED MIST (species misting = avoid) is INERT: no mist due, still cleared', async () => {
    // Canonical misting default is 'avoid' → computeMistingDue returns null regardless of the override.
    const { svc, upserts, cleared } = setup([{ task: 'MIST', intervalDays: 5 }]);
    await svc.recomputePlant('p1');
    expect(upserts.some((u) => u.task === 'MIST')).toBe(false);
    expect(cleared).toContain('MIST');
  });
});
