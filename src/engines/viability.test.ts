import { describe, expect, it } from 'vitest';
import { assessViability, buildViability, type ViabilityInput } from './viability.js';
import type { SpeciesRecord } from '@retaxmaster/my-plants-species-schema';

const ok: ViabilityInput = {
  survivalMinC: 10, survivalMaxC: 35, minLightRank: 1, minHumidityPct: 30,
  seasonalLowC: 16, seasonalHighC: 28, placeLightRank: 2, effectiveHumidityPct: 50,
};

describe('assessViability', () => {
  it('returns good when everything is within tolerance', () => {
    const r = assessViability(ok);
    expect(r.level).toBe('good');
    expect(r.reasons).toEqual([]);
  });

  it('returns poor with a reason when the seasonal low is below survival', () => {
    const r = assessViability({ ...ok, seasonalLowC: 4 });
    expect(r.level).toBe('poor');
    expect(r.reasons.join(' ')).toMatch(/survival minimum/i);
  });

  it('returns caution when light is one rank below the minimum', () => {
    const r = assessViability({ ...ok, placeLightRank: 0, minLightRank: 1 });
    expect(r.level).toBe('caution');
    expect(r.reasons.join(' ')).toMatch(/light/i);
  });

  it('returns caution when humidity is below the minimum', () => {
    const r = assessViability({ ...ok, effectiveHumidityPct: 20, minHumidityPct: 30 });
    expect(r.level).toBe('caution');
    expect(r.reasons.join(' ')).toMatch(/humidity/i);
  });
});

// Minimal record: buildViability only reads temperature/light.minimum/humidity.minimumPct.
const record = {
  temperature: { survivalMinC: 10, survivalMaxC: 35, idealMinC: 18, idealMaxC: 27 },
  light: { minimum: 'medium' as const },
  humidity: { minimumPct: 30 },
} as unknown as SpeciesRecord;

const outdoorMediumLight = {
  indoor: false,
  climateControlled: false,
  humidityCharacter: 'NORMAL' as const,
  indoorTempMinC: null,
  indoorTempMaxC: null,
  lightType: 'MEDIUM' as const, // rank 1 == minimum 'medium' (rank 1)
};

describe('buildViability', () => {
  it('maps light type to its rank and humidity from effectiveConditions', () => {
    // Outdoor place: effective humidity is the passed weather humidity (45 < 30? no -> ok).
    const r = buildViability(record, outdoorMediumLight, {
      tempC: 22, humidityPct: 45, seasonalLowC: 16, seasonalHighC: 28,
    });
    expect(r.level).toBe('good');
    expect(r.reasons).toEqual([]);
  });

  it('flags caution when the place light rank is below the species minimum', () => {
    const r = buildViability(record, { ...outdoorMediumLight, lightType: 'LOW' }, {
      tempC: 22, humidityPct: 45, seasonalLowC: 16, seasonalHighC: 28,
    });
    expect(r.level).toBe('caution');
    expect(r.reasons.join(' ')).toMatch(/light/i);
  });

  it('flags caution on low humidity using the indoor DRY character, not raw weather', () => {
    // Indoor + DRY -> effectiveConditions yields 35%? No: DRY indoor == 35, above 30 -> ok.
    // Force below minimum by raising the species minimum.
    const dryRecord = { ...record, humidity: { minimumPct: 40 } } as unknown as SpeciesRecord;
    const indoorDry = { ...outdoorMediumLight, indoor: true, humidityCharacter: 'DRY' as const };
    const r = buildViability(dryRecord, indoorDry, {
      tempC: 22, humidityPct: 80, seasonalLowC: 16, seasonalHighC: 28,
    });
    // 80% raw weather would pass; DRY indoor 35% is what must be used -> below 40 -> caution.
    expect(r.level).toBe('caution');
    expect(r.reasons.join(' ')).toMatch(/humidity/i);
  });

  it('falls back to ideal min/max for seasonal lo/hi when weather is null', () => {
    // weather null -> seasonalLowC=idealMinC=18, seasonalHighC=idealMaxC=27 (within survival) -> good.
    const r = buildViability(record, { ...outdoorMediumLight, indoor: true }, null);
    expect(r.level).toBe('good');
  });

  it('flags poor when the seasonal low is below the survival minimum', () => {
    const r = buildViability(record, outdoorMediumLight, {
      tempC: 5, humidityPct: 45, seasonalLowC: 4, seasonalHighC: 28,
    });
    expect(r.level).toBe('poor');
    expect(r.reasons.join(' ')).toMatch(/survival minimum/i);
  });

  it('flags poor when the seasonal high is above the survival maximum', () => {
    const r = buildViability(record, outdoorMediumLight, {
      tempC: 40, humidityPct: 45, seasonalLowC: 20, seasonalHighC: 40,
    });
    expect(r.level).toBe('poor');
    expect(r.reasons.join(' ')).toMatch(/survival maximum/i);
  });
});
