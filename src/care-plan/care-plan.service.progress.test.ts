import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';
import { computeProgressDue } from '../engines/scheduling.js';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

// A complete VALID species record — the canonical fixture from plants.service.ownership.test.ts,
// re-validated by parseSpeciesRecord (lowercase hyphenated enums; every required field present).
// parseSpeciesRecord backfills Zod defaults (misting → benefit 'avoid'/baseFrequencyDays null,
// humiditySensitivity → 'low'), so misting yields no task here — this isolates the Progress cycle.
// Do NOT hand-trim this: a partial/miscased record fails Zod .parse and the test throws before asserting.
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

function setup(opts: { lastProgressOn?: Date; acquiredOn: Date }) {
  const upserts: { task: string; nextDueOn: Date }[] = [];
  const cleared: string[] = [];
  const prisma = {
    plant: {
      findUniqueOrThrow: async () => ({
        id: 'p1',
        acquiredOn: opts.acquiredOn,
        species: { record }, // Prisma returns the Json column as an OBJECT (not a string)
        place: { indoor: true, climateControlled: false, humidityCharacter: 'NORMAL', indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', city: { id: 'c1', latitude: 19, longitude: -99, timezone: 'America/Mexico_City' } },
        adjustments: [],
        overrides: [],
        frequencies: [],
      }),
    },
    careEvent: {
      findFirst: async ({ where }: any) =>
        where.task === 'PROGRESS' && opts.lastProgressOn ? { occurredOn: opts.lastProgressOn } : null,
      findMany: async () => [],
    },
    dueCache: {
      upsert: async ({ create }: any) => { upserts.push({ task: create.task, nextDueOn: create.nextDueOn }); },
      deleteMany: async ({ where }: any) => { cleared.push(where.task); },
    },
  } as any;
  const weather = { forCity: async () => null } as any;
  const svc = new CarePlanService(prisma, weather);
  return { svc, upserts, cleared };
}

describe('recomputePlant — Progress cycle', () => {
  it('with no prior Progress event, anchors on acquiredOn → next Monday after it', async () => {
    // 2026-06-30 Tuesday → 2026-07-06 Monday.
    const { svc, upserts } = setup({ acquiredOn: d('2026-06-30') });
    await svc.recomputePlant('p1');
    const progress = upserts.find((u) => u.task === 'PROGRESS');
    expect(progress?.nextDueOn).toEqual(computeProgressDue(d('2026-06-30')));
    expect(progress?.nextDueOn).toEqual(d('2026-07-06'));
  });

  it('after a Progress DONE, re-anchors forward to the Monday after that event', async () => {
    const { svc, upserts } = setup({ acquiredOn: d('2026-01-01'), lastProgressOn: d('2026-07-06') });
    await svc.recomputePlant('p1');
    const progress = upserts.find((u) => u.task === 'PROGRESS');
    // Monday anchor → the FOLLOWING Monday.
    expect(progress?.nextDueOn).toEqual(d('2026-07-13'));
  });

  it('always writes a Progress due (never cleared/skipped)', async () => {
    const { svc, upserts, cleared } = setup({ acquiredOn: d('2026-06-30') });
    await svc.recomputePlant('p1');
    expect(upserts.some((u) => u.task === 'PROGRESS')).toBe(true);
    expect(cleared).not.toContain('PROGRESS');
  });
});
