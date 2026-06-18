export interface AdaptationInput {
  current: number; // current multiplier
  recentPostpones: number; // count in the recent window
  earlyLateRatio: number; // observed interval / scheduled interval (avg over recent dones)
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Small, bounded nudges so the plan adapts gradually rather than oscillating.
export function nextAdjustment(i: AdaptationInput): number {
  const postponeNudge = i.recentPostpones * 0.05; // each postpone lengthens slightly
  const cadenceNudge = (i.earlyLateRatio - 1) * 0.3; // acting early shortens, late lengthens
  return clamp(i.current + postponeNudge + cadenceNudge, 0.5, 2);
}
