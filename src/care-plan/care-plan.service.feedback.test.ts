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
    // No size-bearing progress entry → crowdingIndex is null → the crowding factor is
    // neutral, so these fixtures keep their pre-crowding expectations (spec E, A5.3).
    plantProgressEntry: { findFirst: async () => null },
    careEvent: {
      // recomputePlant reads the per-task last-DONE anchor (findFirst) AND the feedback window (findMany).
      findFirst: async () => null,
      // Honors `take` so a regression test can prove a fixed row cap would truncate the window.
      findMany: async ({ where, take }: any) =>
        where?.type?.in ? (take ? waterEvents.slice(0, take) : waterEvents) : [], // window query has type: { in: [...] }
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

  it('reason-bearing events survive a long run of plain due waterings (window is by reason count, not raw rows)', async () => {
    // 60 plain on-time waterings (DONE, no reason) are the NEWEST events; 10 older justified dry-soil
    // early-waterings sit behind them. A fixed `take: 60` would fetch only the plain run → empty window →
    // silent revert to the species base (4 days). The window is defined by reason-bearing COUNT, so the
    // dry-soil signal must still be found and cross the floor. Guards the frequently-watered fern case.
    const plain = Array.from({ length: 60 }, () => ({ type: 'DONE', payload: { adherence: { observedDays: 4 } } }));
    const dry = Array.from({ length: 10 }, () => ({ type: 'DONE', payload: { reason: 'dry-soil' } }));
    const { svc, dues } = setup([...plain, ...dry]);
    await svc.recomputePlant('pl1');
    expect(daysBetween(new Date('2026-06-01'), dues.WATER)).toBeLessThanOrEqual(2);
  });
});
