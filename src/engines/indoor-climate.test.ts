import { describe, expect, it } from 'vitest';
import { effectiveConditions, type PlaceClimateInput } from './indoor-climate.js';

const outdoor: PlaceClimateInput = {
  indoor: false, climateControlled: false, humidityCharacter: 'NORMAL',
  indoorTempMinC: null, indoorTempMaxC: null,
};
const weather = { tempC: 30, humidityPct: 45 };

describe('effectiveConditions', () => {
  it('passes outdoor weather straight through for outdoor places', () => {
    expect(effectiveConditions(outdoor, weather)).toEqual({ tempC: 30, humidityPct: 45 });
  });

  it('uses the midpoint of an indoor temperature range when provided', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true, indoorTempMinC: 18, indoorTempMaxC: 24 };
    expect(effectiveConditions(place, weather).tempC).toBe(21);
  });

  it('treats a climate-controlled indoor place as a stable comfort baseline', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true, climateControlled: true };
    expect(effectiveConditions(place, weather).tempC).toBe(21);
  });

  it('damps outdoor temperature toward the comfort baseline for a plain indoor place', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true };
    // 21 + 0.4 * (30 - 21) = 24.6
    expect(effectiveConditions(place, weather).tempC).toBeCloseTo(24.6, 5);
  });

  it('raises humidity for a HUMID indoor place and lowers it for DRY', () => {
    const humid: PlaceClimateInput = { ...outdoor, indoor: true, humidityCharacter: 'HUMID' };
    const dry: PlaceClimateInput = { ...outdoor, indoor: true, humidityCharacter: 'DRY' };
    expect(effectiveConditions(humid, weather).humidityPct).toBe(65);
    expect(effectiveConditions(dry, weather).humidityPct).toBe(35);
  });

  it('is neutral when weather is missing (uses baselines)', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true };
    expect(effectiveConditions(place, null)).toEqual({ tempC: 21, humidityPct: 50 });
  });
});
