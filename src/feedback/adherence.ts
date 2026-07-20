import { dayDiff } from '../common/time/local-date.js';
import type { AdherenceCycle } from '../engines/punctuality.js';

// Stamped into CareEvent.payload.adherence for each closed DONE-on-WATER cycle (spec A.2).
export interface AdherencePayload {
  previousAnchorOn: Date;
  scheduledDueOn: Date;
  observedDays: number;
  scheduledDays: number;
  eligible: boolean;
}

// Pure eligibility math. Returns null only when there is no schedule to measure against
// (no due-cache row). Otherwise returns the record with `eligible` set per the A.2 guards:
// eligible = !hadOverride && scheduledDays >= 1 && observedDays >= 1.
export function computeAdherence(input: {
  occurredOn: Date;
  previousAnchor: Date;
  scheduledDueOn: Date | null;
  hadOverride: boolean;
}): AdherencePayload | null {
  if (input.scheduledDueOn === null) return null;
  // INVARIANT (spec §4, care-engine §7.10): an adherence anchor is never after the event it measures.
  // The first cycle anchors at acquisition; a care event recorded before acquisition (or a back-dated
  // event placed before an existing later one) would otherwise stamp a time-reversed cycle (observedDays
  // < 0). Clamping to the earlier date makes the stored record physically coherent. It changes NO eligible
  // cycle: eligibility needs observedDays >= 1, i.e. anchor strictly before the event, which the clamp
  // never touches — it only lifts an already-ineligible negative interval to 0.
  const previousAnchor = new Date(Math.min(input.previousAnchor.getTime(), input.occurredOn.getTime()));
  const observedDays = dayDiff(input.occurredOn, previousAnchor);
  const scheduledDays = dayDiff(input.scheduledDueOn, previousAnchor);
  const eligible = !input.hadOverride && scheduledDays >= 1 && observedDays >= 1;
  return {
    previousAnchorOn: previousAnchor,
    scheduledDueOn: input.scheduledDueOn,
    observedDays,
    scheduledDays,
    eligible,
  };
}

// Filters a newest-first list of parsed payloads down to the eligible cycles the scorer consumes.
export function eligibleCycles(payloads: (AdherencePayload | undefined)[]): AdherenceCycle[] {
  return payloads
    .filter((p): p is AdherencePayload => p !== undefined && p.eligible)
    .map((p) => ({ observedDays: p.observedDays, scheduledDays: p.scheduledDays }));
}
