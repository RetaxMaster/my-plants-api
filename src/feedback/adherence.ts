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
  const observedDays = dayDiff(input.occurredOn, input.previousAnchor);
  const scheduledDays = dayDiff(input.scheduledDueOn, input.previousAnchor);
  const eligible = !input.hadOverride && scheduledDays >= 1 && observedDays >= 1;
  return {
    previousAnchorOn: input.previousAnchor,
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
