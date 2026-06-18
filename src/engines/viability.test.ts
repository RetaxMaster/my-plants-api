import { describe, expect, it } from 'vitest';
import { assessViability, type ViabilityInput } from './viability.js';

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
