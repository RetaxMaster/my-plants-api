import { describe, expect, it, vi } from 'vitest';
import { PlantsService } from './plants.service.js';

// A complete VALID species record. parseSpeciesRecord re-validates the JSON,
// so the fixture must satisfy the schema in full.
// Source of truth for the shape: @retaxmaster/my-plants-species-schema.
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

function makeService(plants: Array<Record<string, unknown>>) {
  const prisma = {
    plant: {
      findMany: vi.fn(async () => plants),
      findFirst: vi.fn(async () => plants[0] ?? null),
    },
  } as unknown as ConstructorParameters<typeof PlantsService>[0];
  const owner = { currentOwnerId: vi.fn(async () => 'owner-1') } as unknown as ConstructorParameters<typeof PlantsService>[1];
  const carePlan = {} as ConstructorParameters<typeof PlantsService>[2];
  const weather = {} as ConstructorParameters<typeof PlantsService>[3];
  return new PlantsService(prisma, owner, carePlan, weather);
}

const plantRow = {
  id: 'plant-1',
  placeId: 'place-1',
  speciesSlug: 'dracaena-trifasciata',
  nickname: 'Snakey',
  acquiredOn: new Date('2026-01-01'),
  species: { scientificName: 'Dracaena trifasciata', record },
};

describe('PlantsService name enrichment', () => {
  it('plant list includes the species common + scientific names', async () => {
    const service = makeService([plantRow]);
    const [p] = await service.list();
    expect(p.speciesScientificName).toBe('Dracaena trifasciata');
    expect(p.speciesCommonName).toBe('Snake plant');
    // the raw nested species object is flattened away
    expect((p as Record<string, unknown>).species).toBeUndefined();
  });

  it('plant detail includes the species common + scientific names', async () => {
    const service = makeService([plantRow]);
    const p = await service.get('plant-1');
    expect(p.speciesScientificName).toBe('Dracaena trifasciata');
    expect(p.speciesCommonName).toBe('Snake plant');
  });
});
