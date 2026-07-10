import { describe, expect, it } from 'vitest';
import { deriveFeedback, deriveRepotResidual, nextAdjustment } from './adaptation.js';

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

describe('deriveFeedback — reason-gated, last-10 WATER window (spec B §3.3/§3.4)', () => {
  const early = (reason: string) => ({ kind: 'early-water', reason } as const);
  const post = (reason: string) => ({ kind: 'postpone', reason } as const);
  const symptom = (s: string) => ({ kind: 'symptom', symptom: s } as const);

  it('an empty window is perfectly neutral', () => {
    expect(deriveFeedback([])).toEqual({ feedbackFactor: 1, feedbackConfidence: 0 });
  });

  it('intuition-only early-waterings move NOTHING (fixes today\'s blind shortening)', () => {
    const s = deriveFeedback([early('intuition'), early('intuition'), early('intuition')]);
    expect(s.feedbackFactor).toBe(1);
    expect(s.feedbackConfidence).toBe(0);
  });

  it('justified dry-soil early-waterings pull the factor below 1 (water sooner) and raise confidence', () => {
    const s = deriveFeedback([early('dry-soil'), early('dry-soil'), early('dry-soil')]);
    expect(s.feedbackFactor).toBeLessThan(1);
    expect(s.feedbackConfidence).toBeGreaterThan(0);
  });

  it('justified soil-still-moist postpones pull the factor above 1 (water later)', () => {
    const s = deriveFeedback([post('soil-still-moist'), post('soil-still-moist')]);
    expect(s.feedbackFactor).toBeGreaterThan(1);
    expect(s.feedbackConfidence).toBeGreaterThan(0);
  });

  it('unjustified postpone reasons (no-time/other) move nothing', () => {
    expect(deriveFeedback([post('no-time'), post('other')])).toEqual({ feedbackFactor: 1, feedbackConfidence: 0 });
  });

  it('opposing justified signals net out toward neutral', () => {
    const s = deriveFeedback([early('dry-soil'), post('soil-still-moist')]);
    expect(s.feedbackFactor).toBeCloseTo(1, 5);
    expect(s.feedbackConfidence).toBeGreaterThan(0); // two justified events → some confidence
  });

  it('the symptom map folds into the SAME factor (over-watering → later, under-watering → sooner)', () => {
    expect(deriveFeedback([symptom('mushy-stem')]).feedbackFactor).toBeGreaterThan(1);
    expect(deriveFeedback([symptom('wilting-dry-soil')]).feedbackFactor).toBeLessThan(1);
    expect(deriveFeedback([symptom('unknown-symptom')])).toEqual({ feedbackFactor: 1, feedbackConfidence: 0 });
  });

  it('only the LAST 10 events count: 10 recent intuition dilute older dry-soil out of the window', () => {
    const window = [
      ...Array.from({ length: 10 }, () => early('intuition')),
      ...Array.from({ length: 5 }, () => early('dry-soil')),
    ];
    // deriveFeedback receives an ALREADY-sliced last-10 window (care-plan slices before calling), so we
    // pass exactly the 10 most-recent: all intuition here → neutral.
    expect(deriveFeedback(window.slice(0, 10))).toEqual({ feedbackFactor: 1, feedbackConfidence: 0 });
  });

  it('confidence saturates at 1 and the factor stays bounded to [0.5, 1.5]', () => {
    const s = deriveFeedback(Array.from({ length: 10 }, () => early('dry-soil')));
    expect(s.feedbackConfidence).toBe(1);
    expect(s.feedbackFactor).toBeGreaterThanOrEqual(0.5);
    expect(s.feedbackFactor).toBeLessThanOrEqual(1.5);
  });
});

describe('deriveRepotResidual — BIDIRECTIONAL root-bound signal from the watering residual (A2.8/A5.4)', () => {
  const early = (reason: string | null) => ({ kind: 'early-water' as const, reason });
  const post = (reason: string | null) => ({ kind: 'postpone' as const, reason });
  const sym = (symptom: string | null) => ({ kind: 'symptom' as const, symptom });

  it('is neutral (factor 1, wr 0) on an empty window', () => {
    expect(deriveRepotResidual([])).toEqual({ residualFactor: 1, residualConfidence: 0 });
  });
  it('justified dry-soil early-water pulls the factor < 1 (root-bound → repot sooner)', () => {
    const s = deriveRepotResidual([early('dry-soil'), early('dry-soil'), early('dry-soil')]);
    expect(s.residualFactor).toBeCloseTo(1 - 3 * 0.03, 10); // 0.91
    expect(s.residualConfidence).toBeCloseTo(3 / 6, 10);
  });
  it('justified soil-still-moist postpone pulls the factor > 1 (holds water → repot later)', () => {
    const s = deriveRepotResidual([post('soil-still-moist'), post('soil-still-moist')]);
    expect(s.residualFactor).toBeCloseTo(1 + 2 * 0.03, 10); // 1.06
    expect(s.residualConfidence).toBeCloseTo(2 / 6, 10);
  });
  it('dry and moist reports oppose and net out (they are exact mirrors)', () => {
    const s = deriveRepotResidual([early('dry-soil'), post('soil-still-moist')]);
    expect(Object.is(s.residualFactor, 1)).toBe(true);
    expect(s.residualConfidence).toBeCloseTo(2 / 6, 10);
  });
  it('reads the DRY symptoms (negative) but EXCLUDES the wet symptoms (confounded with rot)', () => {
    const dry = deriveRepotResidual([sym('wilting-dry-soil'), sym('crispy-edges-dry-soil')]);
    expect(dry.residualFactor).toBeLessThan(1);
    expect(dry.residualConfidence).toBeCloseTo(2 / 6, 10);
    const wet = deriveRepotResidual([sym('mushy-stem'), sym('yellow-leaves-wet-soil')]);
    expect(wet).toEqual({ residualFactor: 1, residualConfidence: 0 });
  });
  it('IGNORES unjustified reasons (intuition / no-time / other)', () => {
    expect(deriveRepotResidual([early('intuition'), post('no-time'), post('other')]))
      .toEqual({ residualFactor: 1, residualConfidence: 0 });
  });
  it('is clamped to [0.85, 1.15] — tighter than WATER on both sides', () => {
    const manyDry = Array(10).fill(0).map(() => early('dry-soil'));
    const manyMoist = Array(10).fill(0).map(() => post('soil-still-moist'));
    expect(deriveRepotResidual(manyDry).residualFactor).toBe(0.85);
    expect(deriveRepotResidual(manyMoist).residualFactor).toBe(1.15);
  });
  it('differs from deriveFeedback: the WATER signal reads wet symptoms, the REPOT residual does not', () => {
    const wet = [sym('mushy-stem')];
    expect(deriveFeedback(wet).feedbackConfidence).toBeGreaterThan(0); // WATER learns from it
    expect(deriveRepotResidual(wet).residualConfidence).toBe(0); // REPOT does not
  });
});
