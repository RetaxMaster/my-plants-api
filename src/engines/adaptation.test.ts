import { describe, expect, it } from 'vitest';
import { nextAdjustment } from './adaptation.js';

describe('nextAdjustment', () => {
  it('keeps the multiplier when there is no signal', () => {
    expect(nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 1 })).toBeCloseTo(1, 5);
  });

  it('lengthens the interval after repeated postpones', () => {
    expect(nextAdjustment({ current: 1, recentPostpones: 3, earlyLateRatio: 1 })).toBeGreaterThan(1);
  });

  it('shortens when the owner acts early (ratio < 1)', () => {
    expect(nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 0.7 })).toBeLessThan(1);
  });

  it('does NOT lengthen on a late cycle (ratio > 1 → no cadence change)', () => {
    // Early-only policy: late waterings are forgetfulness, not a signal.
    expect(nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 1.4 })).toBeCloseTo(1, 5);
  });

  it('applies reduced gain: ratio 0.7 nudges by (0.7-1)*0.15 = -0.045', () => {
    expect(nextAdjustment({ current: 1, recentPostpones: 0, earlyLateRatio: 0.7 })).toBeCloseTo(0.955, 5);
  });

  it('clamps within [0.5, 2]', () => {
    expect(nextAdjustment({ current: 2, recentPostpones: 10, earlyLateRatio: 1 })).toBeLessThanOrEqual(2);
    expect(nextAdjustment({ current: 0.5, recentPostpones: 0, earlyLateRatio: 0.1 })).toBeGreaterThanOrEqual(0.5);
  });

  it('CONVERGES: a consistently-early waterer settles and does NOT slide to the 0.5 floor', () => {
    // The owner waters every ~7 days. The schedule (= base 10 * multiplier) shrinks each DONE; once
    // it reaches the owner's real rhythm the cycle stops being early (ratio enters the deadband),
    // so the nudge stops. Simulate the loop and assert it settles well above the floor.
    const baseSchedule = 10; // days the schedule predicts at multiplier 1
    const ownerInterval = 7; // the owner's true rhythm
    let multiplier = 1;
    for (let i = 0; i < 50; i++) {
      const scheduledDays = baseSchedule * multiplier;
      const ratio = ownerInterval / scheduledDays;
      // mirror computeEarlyRatio's gate: only nudge while the newest cycle is early (deadband 0.1).
      const earlyLateRatio = ratio < 1 - 0.1 ? ratio : 1;
      multiplier = nextAdjustment({ current: multiplier, recentPostpones: 0, earlyLateRatio });
    }
    // Settles near 7/10 = 0.7 (where scheduled ≈ owner interval), NOT pinned at the 0.5 floor.
    expect(multiplier).toBeGreaterThan(0.6);
    expect(multiplier).toBeLessThan(0.85);
  });
});
