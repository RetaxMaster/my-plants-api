import { describe, expect, it } from 'vitest';
import { deriveFeedback, deriveRepotResidual, nextAdjustment,
  nextRepotAdjustment,
  isJustifiedRepotReason,
  REPOT_ALPHA,
  REPOT_Q,
} from './adaptation.js';

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

// ---- Spec F: the REPOT fallback learner ---------------------------------------------------------------

describe('nextAdjustment — the F1.2 bug, pinned BEFORE the fix (this is the *before* half of a pair)', () => {
  // This documents the LIVE PRODUCTION DEFECT that Spec F fixes for REPOT: an unreasoned POSTPONED runs
  // adapt(), and `postponeNudge = recentPostpones * 0.05` COMPOUNDS and never decays, because `current` is
  // read already-nudged and the freshly-created event is inside the 60-day count. A 1.30 multiplier is
  // +108 d (3.6 months) on a 360-day REPOT cadence and +216 d (7.1 months) on a 720-day one — silent
  // lengthening, taught by "I had no time".
  //
  // It is pinned here to prove the magnitude, NOT because it is behaviour we keep. After the fix REPOT no
  // longer calls nextAdjustment at all (it calls nextRepotAdjustment); FERTILIZE/ROTATE/CLEAN_LEAVES/MIST
  // still do — F1.2's named tail, scheduled separately.
  it('the nudge compounds and never decays: 1 -> 1.05 -> 1.15 -> 1.30 over three postpones', () => {
    let m = 1;
    m = nextAdjustment({ current: m, recentPostpones: 1, earlyLateRatio: 1 });
    expect(m).toBeCloseTo(1.05, 10);
    m = nextAdjustment({ current: m, recentPostpones: 2, earlyLateRatio: 1 });
    expect(m).toBeCloseTo(1.15, 10);
    m = nextAdjustment({ current: m, recentPostpones: 3, earlyLateRatio: 1 });
    expect(m).toBeCloseTo(1.3, 10);
  });
});

describe('nextRepotAdjustment — reason-gated Robbins-Monro quantile tracker on ln(multiplier) (spec F6.2)', () => {
  it('not-needed-yet LENGTHENS by exp(+alpha*q): the engine was early', () => {
    const next = nextRepotAdjustment(1, 'not-needed-yet');
    expect(next).toBeCloseTo(Math.exp(Math.log(1) + REPOT_ALPHA * REPOT_Q), 12);
    expect(next).toBeGreaterThan(1);
  });

  it('needed-cannot-now SHORTENS by exp(-alpha*(1-q)) — regardless of overdue', () => {
    // Replaces round 2's "exactly zero" and round 3's "zero if due today". A punctual owner is NEVER
    // overdue, so gating the sign on lateness produced a learner that could only ever discover it was
    // early: a monotone drift toward never repotting.
    const next = nextRepotAdjustment(1, 'needed-cannot-now');
    expect(next).toBeCloseTo(Math.exp(Math.log(1) - REPOT_ALPHA * (1 - REPOT_Q)), 12);
    expect(next).toBeLessThan(1);
  });

  it('the two steps are ASYMMETRIC in the ratio q : (1-q) — this is what puts the fixed point at q', () => {
    const up = Math.log(nextRepotAdjustment(1, 'not-needed-yet'));
    const down = -Math.log(nextRepotAdjustment(1, 'needed-cannot-now'));
    expect(up / down).toBeCloseTo(REPOT_Q / (1 - REPOT_Q), 10); // 0.25 at q = 0.2
  });

  it('could-not-check contributes EXACTLY zero (unjustified — the F1.2 gate)', () => {
    expect(Object.is(nextRepotAdjustment(1.4, 'could-not-check'), 1.4)).toBe(true);
    expect(Object.is(nextRepotAdjustment(1, 'could-not-check'), 1)).toBe(true);
  });

  it('postponeNudge/cadenceNudge do NOT participate: the quantile step is the ONLY term (F6.2a)', () => {
    // Two consecutive not-needed-yet compound ONLY by the quantile step. With the +0.05 postponeNudge
    // still alive, E[step] > 0 always and the tracker would have no fixed point.
    const one = nextRepotAdjustment(1, 'not-needed-yet');
    const two = nextRepotAdjustment(one, 'not-needed-yet');
    expect(two).toBeCloseTo(Math.exp(Math.log(1) + 2 * REPOT_ALPHA * REPOT_Q), 12);
    // and it is nowhere near the buggy generic path, which would give 1.05 then 1.15:
    expect(two).toBeLessThan(1.05);
  });

  it('is clamped to [0.5, 2.0]', () => {
    let m = 1;
    for (let i = 0; i < 100; i++) m = nextRepotAdjustment(m, 'not-needed-yet');
    expect(m).toBeLessThanOrEqual(2.0);
    m = 1;
    for (let i = 0; i < 100; i++) m = nextRepotAdjustment(m, 'needed-cannot-now');
    expect(m).toBeGreaterThanOrEqual(0.5);
  });

  it('isJustifiedRepotReason gates exactly the two ground-truth outcomes', () => {
    expect(isJustifiedRepotReason('not-needed-yet')).toBe(true);
    expect(isJustifiedRepotReason('needed-cannot-now')).toBe(true);
    expect(isJustifiedRepotReason('could-not-check')).toBe(false);
    expect(isJustifiedRepotReason('soil-still-moist')).toBe(false); // a WATER reason on a REPOT event
  });
});

describe('nextRepotAdjustment — stationarity + stability (spec F6.2b — assert P(needed), NOT convergence)', () => {
  // Deterministic LCG so the property is reproducible. Generative model: true time-to-root-bound lognormal;
  // a PUNCTUAL owner reports needed-cannot-now iff cadence >= true time, else not-needed-yet.
  function simulate(cycles: number): number {
    let mult = 1;
    let rng = 1;
    const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    const base = 600;
    const T0 = 660;
    const s = 0.25;
    let needed = 0;
    for (let i = 0; i < cycles; i++) {
      const trueTime = T0 * Math.exp(s * gauss());
      const reason = base * mult >= trueTime ? 'needed-cannot-now' : 'not-needed-yet';
      if (reason === 'needed-cannot-now') needed++;
      mult = nextRepotAdjustment(mult, reason);
    }
    return needed / cycles;
  }

  it('P(needed) approaches q over many cycles — the fixed point IS the q-quantile', () => {
    // NOT a multiplier-convergence assertion: with constant alpha the multiplier random-walks around the
    // quantile forever, so asserting its convergence would be flaky by construction (F6.2b).
    expect(simulate(20000)).toBeCloseTo(REPOT_Q, 1); // measured 0.2001
  });

  it('the multiplier never leaves the clamp under an adversarial monotone sequence', () => {
    let m = 1;
    for (let i = 0; i < 5000; i++) m = nextRepotAdjustment(m, 'not-needed-yet');
    expect(m).toBe(2.0); // pinned by the clamp, never divergent
    for (let i = 0; i < 5000; i++) m = nextRepotAdjustment(m, 'needed-cannot-now');
    expect(m).toBe(0.5);
  });

  it('alpha is small enough that ~22 steps are needed to cross the whole band', () => {
    const maxLnStep = REPOT_ALPHA * Math.max(REPOT_Q, 1 - REPOT_Q);
    const bandWidth = Math.log(2) - Math.log(0.5);
    expect(maxLnStep).toBeCloseTo(0.064, 10);
    expect(bandWidth / maxLnStep).toBeGreaterThan(20); // 21.7 — visible but not jarring
  });
});
