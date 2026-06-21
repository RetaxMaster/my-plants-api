import { describe, expect, it } from 'vitest';
import { extractCommonNames } from './species.brief.js';

// A complete VALID species record. parseSpeciesRecord re-validates the JSON,
// so the fixture must satisfy the schema in full; commonNames is the field under test.
// Source of truth for the shape: @retaxmaster/my-plants-species-schema
// (modeled on its own src/species-record.test.ts validRecord).
const baseRecord = {
  scientificName: 'Monstera deliciosa',
  commonNames: ['Costilla de Adán', 'Swiss cheese plant'],
  watering: {
    baseIntervalDays: 7,
    soilDrynessBeforeWatering: 'half-dry',
    droughtTolerance: 'medium',
    temperatureSensitivity: 'high',
    lightSensitivity: 'medium',
    reduceInDormancy: true,
  },
  light: { minimum: 'medium', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 40, idealPct: 60 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 14, reduceInDormancy: true },
  repotting: { typicalIntervalMonths: 24, signs: ['Roots out of drainage holes'] },
  maintenance: { pruning: 'Trim leggy stems.', rotationDays: 14, leafCleaningDays: 30, commonPests: ['spider mites'] },
  nativeClimate: { description: 'Tropical rainforest understory.', koppen: 'Af', hardinessMinC: 10, hardinessMaxC: 38 },
  metadata: {
    confidence: 'high',
    sources: [{ title: 'RHS', url: 'https://www.rhs.org.uk/plants/monstera', accessedAt: '2026-06-18' }],
  },
};

describe('extractCommonNames', () => {
  it('returns the commonNames array parsed from the record JSON', () => {
    expect(extractCommonNames(baseRecord)).toEqual([
      'Costilla de Adán',
      'Swiss cheese plant',
    ]);
  });

  it('returns an empty array when the record has no commonNames (schema default)', () => {
    const { commonNames: _omit, ...withoutCommonNames } = baseRecord;
    expect(extractCommonNames(withoutCommonNames)).toEqual([]);
  });
});
