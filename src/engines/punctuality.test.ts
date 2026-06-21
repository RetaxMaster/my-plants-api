import { describe, expect, it } from 'vitest';
import { computeEarlyRatio, type AdherenceCycle } from './punctuality.js';

const cycle = (observedDays: number, scheduledDays: number): AdherenceCycle => ({ observedDays, scheduledDays });

describe('computeEarlyRatio', () => {
  it('returns 1 when there are no cycles', () => {
    expect(computeEarlyRatio([], { deadband: 0.1, minSamples: 2 })).toBe(1);
  });

  it('returns 1 when only one cycle is early (below the minSamples confidence gate)', () => {
    // newest early, but only 1 early cycle total → gate not met.
    const cycles = [cycle(6, 10), cycle(10, 10), cycle(11, 10)];
    expect(computeEarlyRatio(cycles, { deadband: 0.1, minSamples: 2 })).toBe(1);
  });

  it('returns the NEWEST cycle ratio when the gate passes and the newest cycle is early', () => {
    // newest-first; two cycles early (6/10 and 7/10), gate met (>=2), newest is early.
    const cycles = [cycle(6, 10), cycle(7, 10), cycle(10, 10)];
    expect(computeEarlyRatio(cycles, { deadband: 0.1, minSamples: 2 })).toBeCloseTo(0.6, 5);
  });

  it('returns 1 when the gate passes but the NEWEST cycle is NOT early', () => {
    // two older cycles early, but newest (10/10) is on-time → no nudge.
    const cycles = [cycle(10, 10), cycle(6, 10), cycle(7, 10)];
    expect(computeEarlyRatio(cycles, { deadband: 0.1, minSamples: 2 })).toBe(1);
  });

  it('respects the deadband: a cycle just inside the band is NOT early', () => {
    // 9.5/10 = 0.95 > 1 - 0.1 = 0.9 → not early; even repeated it never trips the gate.
    const cycles = [cycle(9.5, 10), cycle(9.5, 10), cycle(9.5, 10)];
    expect(computeEarlyRatio(cycles, { deadband: 0.1, minSamples: 2 })).toBe(1);
  });

  it('applies default deadband=0.1 and minSamples=2 when options are omitted', () => {
    const cycles = [cycle(6, 10), cycle(7, 10)];
    expect(computeEarlyRatio(cycles)).toBeCloseTo(0.6, 5);
  });
});
