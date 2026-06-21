export interface AdaptationInput {
  current: number; // current multiplier
  recentPostpones: number; // count in the recent window
  earlyLateRatio: number; // newest eligible cycle's observed/scheduled (< 1 = early); 1 = no signal
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const EARLY_GAIN = 0.15; // reduced gain: acting early shortens weakly. Late is NOT a signal (A.1).

// Small, bounded nudges so the plan adapts gradually rather than oscillating. The cadence nudge is
// EARLY-ONLY (ratio < 1); ratio >= 1 contributes nothing — late waterings never lengthen the rhythm.
export function nextAdjustment(i: AdaptationInput): number {
  const postponeNudge = i.recentPostpones * 0.05; // each postpone lengthens slightly
  const cadenceNudge = i.earlyLateRatio < 1 ? (i.earlyLateRatio - 1) * EARLY_GAIN : 0;
  return clamp(i.current + postponeNudge + cadenceNudge, 0.5, 2);
}
