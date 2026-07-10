import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from '../owner/owner.service.js';
import { PlantsService } from './plants.service.js';

// A complete VALID species record (copied from plants.service.ownership.test.ts; re-validated by
// parseSpeciesRecord on the read path).
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

const plantWithTz = (timezone: string) => ({
  id: 'p1', ownerId: 'owner-1', placeId: 'place-a', speciesSlug: 'dracaena-trifasciata', nickname: 'Sansa',
  acquiredOn: new Date('2026-01-01'),
  species: { scientificName: 'Dracaena trifasciata', record },
  place: { indoor: true, lightType: 'BRIGHT_INDIRECT', climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, city: { id: 'c1', latitude: 10, longitude: 20, timezone } },
});
// NOTE: these fake prismas have NO `city` delegate — if getCare still called city.findFirst it would throw.
type CrowdingFixture = {
  profile?: { potSizeCm: number | null; growthHabit: string | null } | null;
  sized?: { sizeCm: number; occurredOn: Date } | null;
};
const runGetCare = (timezone: string, crowding: CrowdingFixture = {}) => {
  const prisma = {
    plant: { findFirst: async () => plantWithTz(timezone) },
    dueCache: { findMany: async () => [{ task: 'WATER', nextDueOn: new Date(Date.UTC(2026, 5, 21)) }] },
    plantProfile: { findUnique: async () => crowding.profile ?? null },
    plantProgressEntry: { findFirst: async () => crowding.sized ?? null },
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const weather = { forCity: async () => ({ tempC: 20, humidityPct: 50, seasonalLowC: 10, seasonalHighC: 30 }) } as any;
  const svc = new PlantsService(prisma, owner, {} as any, weather, {} as any);
  return cls.run(async () => { cls.set('actor', { userId: 'u', username: 'n', ownerId: 'owner-1', role: 'USER', jti: 'j', exp: 9e9 }); return svc.getCare('p1'); });
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

it('getCare computes the boundary from the plant place-city (no primary lookup)', async () => {
  const out = await runGetCare('UTC');
  expect(out.plantId).toBe('p1');
  expect(out.tasks[0].task).toBe('WATER');
  expect(['overdue', 'today', 'upcoming']).toContain(out.tasks[0].status);
  expect(out.viability).toHaveProperty('level');
});

it('getCare exposes the species soil-dryness on the care payload (for the WATER info modal)', async () => {
  const out = await runGetCare('UTC');
  expect(out.soilDrynessBeforeWatering).toBe('mostly-dry');
});

it('getCare feeds the place-city timezone into the boundary (proven: an invalid tz throws)', async () => {
  // If getCare hardcoded 'UTC' or used the primary, an invalid place-city tz would be ignored.
  // Because the boundary is built from plant.place.city.timezone, an invalid zone makes
  // Intl.DateTimeFormat throw a RangeError — a deterministic proof of the wiring.
  await expect(runGetCare('Not/AZone')).rejects.toThrow();
});

// ---- Spec E, Area A: the crowding block on the care payload (A5.1) ------------------------------------
describe('getCare crowding block', () => {
  const FRESH = { profile: { potSizeCm: 20, growthHabit: 'upright' }, sized: { sizeCm: 60, occurredOn: daysAgo(1) } };

  it('reports the habit-normalized index, marks it engine-read, and names the repotting signs', async () => {
    const out = await runGetCare('UTC', FRESH);
    expect(out.crowding.usedByEngine).toBe(true);
    expect(out.crowding.index).toBeCloseTo(3.0, 10); // 60/20 raw ÷ HABIT_REF.upright (1.0)
    expect(out.crowding.repotSigns).toContain('Roots out of drainage holes');
  });

  it('usedByEngine is false and index null when the pot size is missing', async () => {
    const out = await runGetCare('UTC', { profile: { potSizeCm: null, growthHabit: 'upright' }, sized: FRESH.sized });
    expect(out.crowding.usedByEngine).toBe(false);
    expect(out.crowding.index).toBeNull();
  });

  it('usedByEngine is false and index null when there is no sized progress entry', async () => {
    const out = await runGetCare('UTC', { profile: FRESH.profile, sized: null });
    expect(out.crowding.usedByEngine).toBe(false);
    expect(out.crowding.index).toBeNull();
  });

  it('usedByEngine is false when the height is STALE, even though the index is computable', async () => {
    // The engine raises the factor to freshness = 0, so it is NOT using this height: a green dot would lie.
    const out = await runGetCare('UTC', { profile: FRESH.profile, sized: { sizeCm: 60, occurredOn: daysAgo(800) } });
    expect(out.crowding.index).not.toBeNull();
    expect(out.crowding.usedByEngine).toBe(false);
  });

  it('a trailing habit yields no index at all (height is not the relevant dimension)', async () => {
    const out = await runGetCare('UTC', { profile: { potSizeCm: 20, growthHabit: 'trailing' }, sized: FRESH.sized });
    expect(out.crowding.index).toBeNull();
    expect(out.crowding.usedByEngine).toBe(false);
  });

  it('still returns the repotting signs when crowding is not computable (they are the inspection checklist)', async () => {
    const out = await runGetCare('UTC', { profile: null, sized: null });
    expect(out.crowding.repotSigns).toContain('Roots out of drainage holes');
  });
});
