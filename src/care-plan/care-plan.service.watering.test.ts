import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

// A valid, high-drought species with a long base so a "dries-fast" profile can visibly shorten WATER.
const record = {
  scientificName: 'Test species',
  commonNamesEn: ['Test'],
  watering: { baseIntervalDays: 10, soilDrynessBeforeWatering: 'mostly-dry', droughtTolerance: 'medium', temperatureSensitivity: 'low', lightSensitivity: 'low', reduceInDormancy: false },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 30, idealPct: 45 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: false },
  repotting: { typicalIntervalMonths: 36, signs: ['Roots out of holes'] },
  maintenance: { pruning: 'Trim.', rotationDays: null, leafCleaningDays: null, commonPests: [] },
  nativeClimate: { description: 'Dry.', koppen: 'Aw', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: { confidence: 'high', sources: [{ title: 'X', url: 'https://x.test', accessedAt: '2026-06-18' }] },
};

// Build a CarePlanService whose Prisma returns one plant (optionally with a profile + place airflow) and
// captures every WATER due it upserts. No real DB; weather is offline (null → comfort baseline, no signal).
function setup(opts: { profile?: any; airflow?: string | null }) {
  const dues: Record<string, Date> = {};
  const plant = {
    id: 'pl1', acquiredOn: new Date('2026-06-01'),
    species: { record },
    place: { id: 'place1', indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', airflow: opts.airflow ?? null, city: { id: 'c1', latitude: 10, longitude: 20, timezone: 'UTC' } },
    adjustments: [], overrides: [], frequencies: [],
    profile: opts.profile ?? null,
  };
  const prisma = {
    plant: { findUniqueOrThrow: async () => plant },
    // No size-bearing progress entry → crowdingIndex is null → the crowding factor is
    // neutral, so these fixtures keep their pre-crowding expectations (spec E, A5.3).
    plantProgressEntry: { findFirst: async () => null },
    careEvent: { findFirst: async () => null, findMany: async () => [] },
    dueCache: {
      upsert: async ({ where, create }: any) => { dues[where.plantId_task.task] = create?.nextDueOn ?? null; },
      deleteMany: async () => {},
    },
  } as any;
  const weather = { forCity: async () => null } as any; // offline → no real temp/humidity signal
  const svc = new CarePlanService(prisma, weather);
  return { svc, dues };
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

describe('CarePlanService — profile/airflow feed the WATER schedule', () => {
  it('with no profile and no weather signal, WATER is the plain base interval (backward-compat)', async () => {
    const { svc, dues } = setup({});
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBe(10);
  });

  it('a small porous pot + breezy air + fast mix shortens WATER below base', async () => {
    const { svc, dues } = setup({
      profile: { windowDistance: null, growLight: null, potType: 'terracotta', potSizeCm: 8, hasDrainage: true, soilMix: 'cactus-succulent', growthHabit: null, ageMonths: null, nearHeater: true },
      airflow: 'breezy',
    });
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBeLessThan(10);
  });
});
