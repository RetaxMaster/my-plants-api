import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

// A low-drought fern with base 4 → today's hard floor is round(4 × 0.75) = 3 days. No profile, no airflow,
// weather offline (no real temp/humidity signal), so ONLY the feedback window can move the schedule.
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

function setup(waterEvents: { type: string; payload: unknown }[]) {
  const dues: Record<string, Date> = {};
  const plant = {
    id: 'pl1', acquiredOn: new Date('2026-06-01'),
    species: { record },
    place: { id: 'place1', indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT', airflow: null, city: { id: 'c1', latitude: 10, longitude: 20, timezone: 'UTC' } },
    adjustments: [], overrides: [], frequencies: [], profile: null,
  };
  const prisma = {
    plant: { findUniqueOrThrow: async () => plant },
    careEvent: {
      // recomputePlant reads the per-task last-DONE anchor (findFirst) AND the feedback window (findMany).
      findFirst: async () => null,
      findMany: async ({ where }: any) =>
        where?.type?.in ? waterEvents : [], // only the feedback-window query has type: { in: [...] }
    },
    dueCache: {
      upsert: async ({ where, create }: any) => { dues[where.plantId_task.task] = create?.nextDueOn ?? null; },
      deleteMany: async () => {},
    },
  } as any;
  const weather = { forCity: async () => null } as any; // offline → no real signal
  const svc = new CarePlanService(prisma, weather);
  return { svc, dues };
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

describe('CarePlanService — reason-aware WATER feedback crosses the floor', () => {
  it('no feedback → the plain base interval (4 days), floor intact', async () => {
    const { svc, dues } = setup([]);
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBe(4);
  });

  it('repeated justified dry-soil early-waterings schedule below the old 3-day floor', async () => {
    const events = Array.from({ length: 10 }, () => ({ type: 'DONE', payload: { reason: 'dry-soil' } }));
    const { svc, dues } = setup(events);
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBeLessThanOrEqual(2);
  });

  it('an intuition-only history reproduces the base schedule exactly (no blind shortening)', async () => {
    const events = Array.from({ length: 10 }, () => ({ type: 'DONE', payload: { reason: 'intuition' } }));
    const { svc, dues } = setup(events);
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBe(4);
  });
});
