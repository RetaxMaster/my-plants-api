import { describe, expect, it } from 'vitest';
import { nextAdjustment, type AdaptationInput } from './adaptation.js';

describe('nextAdjustment', () => {
  it('keeps the multiplier when there is no signal', () => {
    expect(nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 1 })).toBeCloseTo(1, 5);
  });

  it('lengthens the interval after repeated postpones', () => {
    const next = nextAdjustment({ current: 1, recentPostpones: 3, earlyLateRatio: 1 });
    expect(next).toBeGreaterThan(1);
  });

  it('shortens when the owner consistently acts early (ratio < 1)', () => {
    const next = nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 0.7 });
    expect(next).toBeLessThan(1);
  });

  it('clamps within [0.5, 2]', () => {
    expect(nextAdjustment({ current: 2, recentPostpones: 10, earlyLateRatio: 2 })).toBeLessThanOrEqual(2);
    expect(nextAdjustment({ current: 0.5, recentPostpones: 0, earlyLateRatio: 0.1 })).toBeGreaterThanOrEqual(0.5);
  });
});
