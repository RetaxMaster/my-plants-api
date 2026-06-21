import { describe, expect, it, vi } from 'vitest';
import { MovingService } from './moving.service.js';

// A complete VALID species record (re-validated by parseSpeciesRecord).
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

const plantRow = {
  id: 'plant-1',
  nickname: 'Snakey',
  speciesSlug: 'dracaena-trifasciata',
  species: { record },
  place: {
    indoor: true,
    climateControlled: true,
    humidityCharacter: 'neutral',
    indoorTempMinC: 18,
    indoorTempMaxC: 26,
    lightType: 'bright-indirect',
  },
};

function makeService() {
  const prisma = {
    plant: { findMany: vi.fn(async () => [plantRow]) },
  } as unknown as ConstructorParameters<typeof MovingService>[0];
  const owner = { currentOwnerId: vi.fn(async () => 'owner-1') } as unknown as ConstructorParameters<typeof MovingService>[1];
  const weather = {
    forLocation: vi.fn(async () => ({ tempC: 22, humidityPct: 50, seasonalLowC: 12, seasonalHighC: 30 })),
  } as unknown as ConstructorParameters<typeof MovingService>[2];
  const carePlan = {} as ConstructorParameters<typeof MovingService>[3];
  return new MovingService(prisma, owner, weather, carePlan);
}

describe('MovingService.simulate', () => {
  it('includes the species common + scientific names on each viability result', async () => {
    const svc = makeService();
    const [r] = await svc.simulate(20.6668, -103.3918);
    expect(r.plantId).toBe('plant-1');
    expect(r.speciesScientificName).toBe('Dracaena trifasciata');
    expect(r.speciesCommonName).toBe('Snake plant');
    expect(r.level).toBeDefined();
    expect(Array.isArray(r.reasons)).toBe(true);
  });
});
