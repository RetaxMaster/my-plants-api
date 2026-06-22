import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from '../owner/owner.service.js';
import { PlantsService } from './plants.service.js';

// A complete VALID species record (copied from plants.service.ownership.test.ts; re-validated by
// parseSpeciesRecord on the read path).
const record = {
  scientificName: 'Dracaena trifasciata',
  commonNames: ['Snake plant'],
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
const runGetCare = (timezone: string) => {
  const prisma = {
    plant: { findFirst: async () => plantWithTz(timezone) },
    dueCache: { findMany: async () => [{ task: 'WATER', nextDueOn: new Date(Date.UTC(2026, 5, 21)) }] },
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const weather = { forCity: async () => ({ tempC: 20, humidityPct: 50, seasonalLowC: 10, seasonalHighC: 30 }) } as any;
  const svc = new PlantsService(prisma, owner, {} as any, weather);
  return cls.run(async () => { cls.set('actor', { userId: 'u', username: 'n', ownerId: 'owner-1', role: 'USER', jti: 'j', exp: 9e9 }); return svc.getCare('p1'); });
};

it('getCare computes the boundary from the plant place-city (no primary lookup)', async () => {
  const out = await runGetCare('UTC');
  expect(out.plantId).toBe('p1');
  expect(out.tasks[0].task).toBe('WATER');
  expect(['overdue', 'today', 'upcoming']).toContain(out.tasks[0].status);
  expect(out.viability).toHaveProperty('level');
});

it('getCare feeds the place-city timezone into the boundary (proven: an invalid tz throws)', async () => {
  // If getCare hardcoded 'UTC' or used the primary, an invalid place-city tz would be ignored.
  // Because the boundary is built from plant.place.city.timezone, an invalid zone makes
  // Intl.DateTimeFormat throw a RangeError — a deterministic proof of the wiring.
  await expect(runGetCare('Not/AZone')).rejects.toThrow();
});
