import { describe, expect, it } from 'vitest';
import {
  computeCadenceDue,
  computeFertilizingDue,
  computeNextDue,
  type ScheduleInput,
} from './scheduling.js';

const base: ScheduleInput = {
  baseIntervalDays: 10,
  droughtTolerance: 'medium',
  temperatureSensitivity: 'high',
  lightSensitivity: 'low',
  reduceInDormancy: true,
  idealMinC: 18,
  idealMaxC: 27,
  idealLightRank: 2, // bright-indirect
  anchor: new Date('2026-06-01'),
  adjustment: 1,
  effective: { tempC: 22, humidityPct: 55 },
  placeLightRank: 2,
  isOutdoor: true,
  weatherAvailable: true,
  season: 'summer',
  reduceSeason: 'winter',
};

describe('computeNextDue', () => {
  it('returns anchor + base interval at ideal conditions', () => {
    const due = computeNextDue(base);
    expect(due.toISOString().slice(0, 10)).toBe('2026-06-11');
  });

  it('shortens the interval in hot weather for a temperature-sensitive plant', () => {
    const due = computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 40 } });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThan(10);
  });

  it('ignores outdoor heat for an indoor plant', () => {
    const outdoorHot = computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 40 } });
    const indoorHot = computeNextDue({ ...base, isOutdoor: false, effective: { tempC: 33, humidityPct: 40 } });
    expect(indoorHot.getTime()).toBeGreaterThan(outdoorHot.getTime());
  });

  it('is neutral on temperature when outdoor weather is unavailable', () => {
    const noWeather = computeNextDue({
      ...base,
      weatherAvailable: false,
      effective: { tempC: 33, humidityPct: 40 }, // would otherwise shorten
    });
    const days = Math.round((noWeather.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBe(10); // base interval, temperature modulator forced to 1.0
  });

  it('lengthens during dormancy when reduceInDormancy is set', () => {
    const dormant = computeNextDue({ ...base, season: 'winter' });
    const days = Math.round((dormant.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeGreaterThan(10);
  });

  it('applies the per-plant adjustment multiplier', () => {
    const due = computeNextDue({ ...base, adjustment: 1.5 });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBe(15);
  });

  it('clamps to the drought-tolerance bounds', () => {
    const tight = computeNextDue({ ...base, droughtTolerance: 'low', adjustment: 5 });
    const days = Math.round((tight.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThanOrEqual(15); // low tolerance caps at base * 1.5
  });
});

const anchor = new Date('2026-06-01');
const daysFrom = (d: Date): number => Math.round((d.getTime() - anchor.getTime()) / 86_400_000);

describe('computeCadenceDue (rotation / leaf-cleaning / repotting — pure cadence)', () => {
  it('is anchor + cadence, unaffected by weather or season', () => {
    expect(daysFrom(computeCadenceDue({ cadenceDays: 14, adjustment: 1, anchor }))).toBe(14);
  });

  it('applies the per-plant adjustment', () => {
    expect(daysFrom(computeCadenceDue({ cadenceDays: 14, adjustment: 2, anchor }))).toBe(28);
  });
});

describe('computeFertilizingDue (season-aware)', () => {
  it('uses the in-season frequency during an active season', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'summer',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: true,
    });
    expect(daysFrom(due)).toBe(21);
  });

  it('pushes far out when dormant and reduceInDormancy is set', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'winter',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: true,
    });
    expect(daysFrom(due)).toBe(84); // DORMANT factor 4
  });

  it('mildly lengthens out of season when reduceInDormancy is false', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'winter',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: false,
    });
    expect(daysFrom(due)).toBe(42); // INACTIVE factor 2
  });
});
