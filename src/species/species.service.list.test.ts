import { describe, expect, it, vi } from 'vitest';
import { SpeciesService } from './species.service.js';

// A complete VALID species record (re-validated by parseSpeciesRecord on read).
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

function makeService(rows: Array<Record<string, unknown>>) {
  const prisma = {
    species: { findMany: vi.fn(async () => rows) },
  } as unknown as ConstructorParameters<typeof SpeciesService>[0];
  return new SpeciesService(prisma);
}

describe('SpeciesService.list', () => {
  it('returns the primary common name alongside slug + scientific name', async () => {
    const service = makeService([
      { slug: 'dracaena-trifasciata', scientificName: 'Dracaena trifasciata', record },
    ]);
    const [s] = await service.list();
    expect(s).toEqual({
      slug: 'dracaena-trifasciata',
      scientificName: 'Dracaena trifasciata',
      commonName: 'Snake plant',
    });
  });
});
