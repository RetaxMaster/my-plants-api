import { JUSTIFIED_EARLY_WATER_REASON, JUSTIFIED_POSTPONE_REASON } from '@retaxmaster/my-plants-species-schema';

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

// ---- Spec B: reason-gated WATER learning (spec B §3.3/§3.4) --------------------------------------------
// The engine's optional-channel feedback signal is a PURE function of the plant's last-10 reason/symptom-
// bearing WATER feedback events (already sliced to 10, newest-first, by the caller). Only JUSTIFIED reasons
// and known symptoms move it; `intuition`/`no-time`/`other`/unknown contribute nothing. dry-soil (and
// under-watering symptoms) pull the factor < 1 (water sooner); soil-still-moist (and over-watering
// symptoms) pull it > 1 (water later); they oppose and net out. This REPLACES the old early-ratio /
// 60-day-postpone / symptom-map adaptation for WATER, feeding Spec A §3.6's optional channel instead of a
// raw multiplier — so justified feedback can cross the old floor with no bespoke bypass.
export type FeedbackWindowEvent =
  | { kind: 'early-water'; reason: string | null }
  | { kind: 'postpone'; reason: string | null }
  | { kind: 'symptom'; symptom: string | null };

export interface FeedbackSignal {
  feedbackFactor: number; // center-moving, bounded [FB_MIN, FB_MAX]; 1 = no move
  feedbackConfidence: number; // [0,1]; 0 = no justified evidence, ~1 near the window size
}

const FB_MIN = 0.5;
const FB_MAX = 1.5;
const DRY_SOIL_STEP = -0.09; // each justified dry-soil early-water pulls the center shorter
const SOIL_MOIST_STEP = 0.09; // each justified soil-still-moist postpone pulls it longer
// The v1 symptom→watering map, folded into the SAME channel (spec B §3.4). Over-watering signs → later;
// under-watering signs → sooner. Magnitudes mirror the retired adaptForSymptom map.
const SYMPTOM_STEP: Record<string, number> = {
  'yellow-leaves-wet-soil': 0.15,
  'mushy-stem': 0.2,
  'wilting-dry-soil': -0.15,
  'crispy-edges-dry-soil': -0.1,
};
const CONFIDENCE_FULL = 6; // this many justified events ≈ full confidence (tunable; locked by tests)

// Pure. `window` MUST already be sliced to the 10 most-recent reason/symptom-bearing WATER events.
export function deriveFeedback(window: FeedbackWindowEvent[]): FeedbackSignal {
  let net = 0;
  let justified = 0;
  for (const e of window) {
    let step = 0;
    if (e.kind === 'early-water' && e.reason === JUSTIFIED_EARLY_WATER_REASON) step = DRY_SOIL_STEP;
    else if (e.kind === 'postpone' && e.reason === JUSTIFIED_POSTPONE_REASON) step = SOIL_MOIST_STEP;
    else if (e.kind === 'symptom' && e.symptom != null) step = SYMPTOM_STEP[e.symptom] ?? 0;
    if (step !== 0) {
      net += step;
      justified += 1;
    }
  }
  const feedbackFactor = clamp(1 + net, FB_MIN, FB_MAX);
  const feedbackConfidence = clamp(justified / CONFIDENCE_FULL, 0, 1);
  return { feedbackFactor, feedbackConfidence };
}
