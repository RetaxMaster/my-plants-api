import { describe, expect, it } from 'vitest';
import { effectiveConditions, vpd, type PlaceClimateInput } from './indoor-climate.js';

const outdoor: PlaceClimateInput = {
  indoor: false, climateControlled: false, humidityCharacter: 'NORMAL',
  indoorTempMinC: null, indoorTempMaxC: null,
};
const weather = { tempC: 30, humidityPct: 45 };

describe('effectiveConditions', () => {
  it('passes outdoor weather straight through for outdoor places', () => {
    expect(effectiveConditions(outdoor, weather)).toEqual({
      tempC: 30, humidityPct: 45, tempSignal: true, humiditySignal: true,
    });
  });

  it('uses the midpoint of an indoor temperature range when provided', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true, indoorTempMinC: 18, indoorTempMaxC: 24 };
    expect(effectiveConditions(place, weather).tempC).toBe(21);
  });

  it('treats a climate-controlled indoor place as a stable comfort baseline', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true, climateControlled: true };
    expect(effectiveConditions(place, weather).tempC).toBe(21);
  });

  it('raises humidity for a HUMID indoor place and lowers it for DRY', () => {
    const humid: PlaceClimateInput = { ...outdoor, indoor: true, humidityCharacter: 'HUMID' };
    const dry: PlaceClimateInput = { ...outdoor, indoor: true, humidityCharacter: 'DRY' };
    expect(effectiveConditions(humid, weather).humidityPct).toBe(65);
    expect(effectiveConditions(dry, weather).humidityPct).toBe(35);
  });

  it('indoor with no range, not climate-controlled, falls back to raw outdoor temp (real signal)', () => {
    const e = effectiveConditions(
      { indoor: true, climateControlled: false, humidityCharacter: 'NORMAL', indoorTempMinC: null, indoorTempMaxC: null },
      { tempC: 33, humidityPct: 40 },
    );
    expect(e.tempC).toBe(33);
    expect(e.tempSignal).toBe(true);
  });

  it('indoor climate-controlled with no range stays at the comfort baseline (no temp signal)', () => {
    const e = effectiveConditions(
      { indoor: true, climateControlled: true, humidityCharacter: 'NORMAL', indoorTempMinC: null, indoorTempMaxC: null },
      { tempC: 33, humidityPct: 40 },
    );
    expect(e.tempC).toBe(21);
    expect(e.tempSignal).toBe(false);
  });

  it('indoor with a null humidityCharacter falls back to outdoor humidity (real signal)', () => {
    const e = effectiveConditions(
      { indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: 20, indoorTempMaxC: 22 },
      { tempC: 25, humidityPct: 70 },
    );
    expect(e.humidityPct).toBe(70);
    expect(e.humiditySignal).toBe(true);
  });

  it('indoor with null humidity and no weather uses the 50% baseline (no humidity signal)', () => {
    const e = effectiveConditions(
      { indoor: true, climateControlled: false, humidityCharacter: null, indoorTempMinC: 20, indoorTempMaxC: 22 },
      null,
    );
    expect(e.humidityPct).toBe(50);
    expect(e.humiditySignal).toBe(false);
  });

  it('outdoor with weather is a real signal for both', () => {
    const e = effectiveConditions(
      { indoor: false, climateControlled: false, humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null },
      { tempC: 30, humidityPct: 45 },
    );
    expect(e).toEqual({ tempC: 30, humidityPct: 45, tempSignal: true, humiditySignal: true });
  });

  it('is neutral when weather is missing (uses baselines)', () => {
    const place: PlaceClimateInput = { ...outdoor, indoor: true };
    expect(effectiveConditions(place, null)).toEqual({
      tempC: 21, humidityPct: 50, tempSignal: false, humiditySignal: true,
    });
  });
});

describe('vpd (vapour-pressure deficit, kPa)', () => {
  it('is ~0 in fully saturated air (100% RH)', () => {
    expect(vpd(21, 100)).toBeCloseTo(0, 5);
  });

  it('rises as air gets hotter at the same RH (thirstier air)', () => {
    expect(vpd(30, 50)).toBeGreaterThan(vpd(20, 50));
  });

  it('rises as air gets drier at the same temperature', () => {
    expect(vpd(22, 30)).toBeGreaterThan(vpd(22, 70));
  });

  it('matches the Tetens value at 22C / 60% within tolerance', () => {
    // es(22) = 0.6108 * exp(17.27*22 / (22+237.3)) ≈ 2.645 kPa ; VPD = es * (1 - 0.60) ≈ 1.058
    expect(vpd(22, 60)).toBeCloseTo(1.058, 2);
  });

  it('clamps out-of-range humidity (never negative)', () => {
    expect(vpd(22, 120)).toBeGreaterThanOrEqual(0);
  });
});
