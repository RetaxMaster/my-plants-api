// Pure early-signal scorer (spec A.3). Input cycles are the recent ELIGIBLE adherence records for
// (plant, WATER), newest first. Late/on-time cycles never push the cadence — early only.
export interface AdherenceCycle {
  observedDays: number;  // actual interval since the previous anchor
  scheduledDays: number; // interval the schedule predicted for that cycle
}

export interface EarlyRatioOptions {
  deadband: number;   // a cycle counts as "early" only below scheduled * (1 - deadband)
  minSamples: number; // confidence gate: at least this many recent cycles must be early
}

const DEFAULTS: EarlyRatioOptions = { deadband: 0.1, minSamples: 2 };

// Returns the NEWEST eligible cycle's ratio (observed/scheduled, < 1) when BOTH hold:
//   (1) at least minSamples of the recent cycles are early (confidence gate), AND
//   (2) the newest cycle itself is early.
// Otherwise returns 1 (no change). The window is ONLY a confidence gate — never an averaged value
// re-applied each event (that is the ratchet-to-floor design the spec explicitly rejects).
export function computeEarlyRatio(
  cycles: AdherenceCycle[],
  options: EarlyRatioOptions = DEFAULTS,
): number {
  const { deadband, minSamples } = options;
  if (cycles.length === 0) return 1;

  const isEarly = (c: AdherenceCycle): boolean => c.observedDays < c.scheduledDays * (1 - deadband);

  const earlyCount = cycles.filter(isEarly).length;
  if (earlyCount < minSamples) return 1;

  const newest = cycles[0];
  if (!isEarly(newest)) return 1;

  return newest.observedDays / newest.scheduledDays;
}
