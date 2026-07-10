import {
  JUSTIFIED_EARLY_WATER_REASON,
  JUSTIFIED_POSTPONE_REASON,
  JUSTIFIED_REPOT_REASONS,
  type RepotPostponeReason,
} from '@retaxmaster/my-plants-species-schema';

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

// ---- Spec E, Area A (A2.8/A5.4): the watering model's RESIDUAL, read as a BIDIRECTIONAL root-bound
// signal for REPOT. Once pot volume, evaporative demand, soil and drainage are all controlled for, a
// persistent residual says the reservoir is not the size the pot's geometry implies. The two UNAMBIGUOUS
// substrate-state reports are exact mirrors: `dry-soil` (a justified early-water) says the reservoir is
// SMALLER than geometry implies → root-bound → repot SOONER (factor < 1); `soil-still-moist` (a justified
// postpone) says it holds MORE water → repot LATER (factor > 1). The DRY symptoms also push down; the WET
// symptoms (mushy-stem, yellow-leaves-wet-soil) are EXCLUDED — confounded with rot. `window` MUST already
// be sliced by the caller to the 10 most-recent reason-bearing WATER events SINCE the last REPOT DONE.
export const REPOT_RESID_STEP = 0.03; // TUNED per-event step magnitude.
export const REPOT_CONFIDENCE_FULL = 6; // TUNED: this many justified events ≈ full wr.
const REPOT_RESID_LO = 0.85, REPOT_RESID_HI = 1.15; // TUNED: tighter than WATER's [0.5, 1.5] both sides.
const REPOT_RESID_DRY_SYMPTOMS = new Set(['wilting-dry-soil', 'crispy-edges-dry-soil']);

export interface RepotResidualSignal {
  residualFactor: number; // [0.85, 1.15]; 1 = no evidence.
  residualConfidence: number; // [0,1]; the `wr` of A5.4
}

export function deriveRepotResidual(window: FeedbackWindowEvent[]): RepotResidualSignal {
  let net = 0;
  let justified = 0;
  for (const e of window) {
    let step = 0;
    if (e.kind === 'early-water' && e.reason === JUSTIFIED_EARLY_WATER_REASON) step = -REPOT_RESID_STEP; // dry → sooner
    else if (e.kind === 'postpone' && e.reason === JUSTIFIED_POSTPONE_REASON) step = REPOT_RESID_STEP; // moist → later
    else if (e.kind === 'symptom' && e.symptom != null && REPOT_RESID_DRY_SYMPTOMS.has(e.symptom)) step = -REPOT_RESID_STEP;
    if (step !== 0) {
      net += step;
      justified += 1;
    }
  }
  return {
    residualFactor: clamp(1 + net, REPOT_RESID_LO, REPOT_RESID_HI),
    residualConfidence: clamp(justified / REPOT_CONFIDENCE_FULL, 0, 1),
  };
}

// ---- Spec F §F6.2: the REPOT fallback learner — a Robbins–Monro quantile tracker (Robbins & Monro, 1951).
// Used ONLY when an inspection has no fresh R_obs to feed the F.5 calibration (routing is decided at submit
// time and persisted as payload.routedTo). We do not want the due date at the MEAN time-to-root-bound; we
// want it at a chosen LOW quantile q — "I accept arriving late q of the time". Sizing the two steps so that
// E[step] = 0 exactly there gives E[step] = 0 <=> P(needed) = q, i.e. the multiplier's fixed point IS the
// q-quantile of this plant's true time-to-root-bound:
//
//   not-needed-yet     -> +alpha*q        (the engine was early -> lengthen)
//   needed-cannot-now  -> -alpha*(1-q)    (the engine was NOT early -> shorten)
//   could-not-check    ->  0              (logistics, not information — the F1.2 justification gate)
//
// Run on ln(multiplier): the additive step on a multiplicative quantity would otherwise vary 4x across
// [0.5, 2]. CRITICAL (F6.2a): postponeNudge/cadenceNudge do NOT participate. If they did,
// E[step] = alpha*(q - p) + 0.05*E[recentPostpones] > 0 ALWAYS, the ratchet returns fed by the justified
// reasons themselves, and the tracker has no fixed point. That is why REPOT gets its own function rather
// than a branch inside nextAdjustment (which is left untouched for WATER/FERTILIZE/ROTATE/CLEAN_LEAVES).
//
// NOTE (F6.2b): with a CONSTANT alpha this does not converge — it converges IN DISTRIBUTION, random-walking
// around the q-quantile. A test asserting "the multiplier converges" is flaky by construction; assert the
// stationarity of P(needed) instead.
export const REPOT_ALPHA = 0.08; // TUNED gain. Stability: max single ln-step alpha*max(q,1-q) = 0.064
//                                  (a 6.6% multiplier change) against a band width ln2 - ln0.5 = 1.386,
//                                  so ~22 steps to cross the whole band; an adversarial monotone run is
//                                  pinned by the clamp, never divergent. Simulated P(needed) = 0.200.
export const REPOT_Q = 0.2; // TUNED target quantile — a stated risk posture ("root-bound 1 inspection in 5").
const REPOT_MULT_LO = 0.5;
const REPOT_MULT_HI = 2.0;
const JUSTIFIED_REPOT = new Set<string>(JUSTIFIED_REPOT_REASONS);

// True for the two inspection outcomes that carry ground truth. `could-not-check` is pure logistics and is
// the F1.2 gate: it must never move the cadence.
export const isJustifiedRepotReason = (reason: string): boolean => JUSTIFIED_REPOT.has(reason);

export function nextRepotAdjustment(current: number, reason: RepotPostponeReason): number {
  let step = 0;
  if (reason === 'not-needed-yet') step = REPOT_ALPHA * REPOT_Q;
  else if (reason === 'needed-cannot-now') step = -REPOT_ALPHA * (1 - REPOT_Q);
  // could-not-check (and any non-justified reason) -> step stays 0; `current` is returned LITERALLY.
  if (step === 0) return current;
  return clamp(Math.exp(Math.log(current) + step), REPOT_MULT_LO, REPOT_MULT_HI);
}
