import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from '../owner/owner.service.js';
import { MovingService } from './moving.service.js';

// A complete VALID species record (re-validated by parseSpeciesRecord), inlined to keep this test
// self-contained (the `record` constant in plants.service.ownership.test.ts is a local, not exported).
const record = {
  scientificName: 'Dracaena trifasciata',
  commonNames: ['Snake plant', 'Mother-in-law tongue'],
  watering: {
    baseIntervalDays: 14,
    soilDrynessBeforeWatering: 'mostly-dry',
    droughtTolerance: 'high',
    temperatureSensitivity: 'low',
    lightSensitivity: 'low',
    reduceInDormancy: true,
  },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 30, idealPct: 45 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: true },
  repotting: { typicalIntervalMonths: 36, signs: ['Roots out of drainage holes'] },
  maintenance: { pruning: 'Remove damaged leaves.', rotationDays: 30, leafCleaningDays: 30, commonPests: ['mealybugs'] },
  nativeClimate: { description: 'West African dry tropics.', koppen: 'Aw', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: {
    confidence: 'high',
    sources: [{ title: 'RHS', url: 'https://www.rhs.org.uk/plants/dracaena', accessedAt: '2026-06-18' }],
  },
};

const placeFields = { indoor: false, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null, lightType: 'BRIGHT_INDIRECT' };
const plant = (id: string, cityId: string) => ({ id, ownerId: 'o1', nickname: id, speciesSlug: 'dracaena-trifasciata', species: { record }, place: { ...placeFields, cityId } });

function makePrisma(hasPrimary: boolean) {
  const all = [plant('p1', 'c-primary'), plant('p2', 'c-other')];
  return {
    city: { findFirst: async ({ where }: any) => (where.isPrimary && hasPrimary ? { id: 'c-primary', timezone: 'UTC' } : null) },
    plant: {
      findMany: async ({ where }: any) =>
        where.place?.cityId ? all.filter((p) => p.place.cityId === where.place.cityId) : all,
    },
  } as any;
}

function svcWith(prisma: any) {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const weather = { forLocation: async () => ({ tempC: 20, humidityPct: 50, seasonalLowC: 10, seasonalHighC: 30 }) } as any;
  const svc = new MovingService(prisma, owner, weather, {} as any);
  const run = <T>(fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', { userId: 'u', username: 'n', ownerId: 'o1', role: 'USER', jti: 'j', exp: 9e9 }); return fn(); });
  return { svc, run };
}

describe('MovingService.simulate scoping', () => {
  it('excludes plants whose place is in a non-primary city', async () => {
    const { svc, run } = svcWith(makePrisma(true));
    const out = await run(() => svc.simulate(1, 2));
    expect(out.map((p) => p.plantId)).toEqual(['p1']);
  });

  it('no-primary fallback simulates all owner plants', async () => {
    const { svc, run } = svcWith(makePrisma(false));
    const out = await run(() => svc.simulate(1, 2));
    expect(out.map((p) => p.plantId).sort()).toEqual(['p1', 'p2']);
  });
});
