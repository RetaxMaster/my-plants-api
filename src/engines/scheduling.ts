import type {
  Airflow, DroughtTolerance, GrowthHabit, MistingBenefit, PotType, Season, Sensitivity, SoilMix, WindowDist,
} from '@retaxmaster/my-plants-species-schema';
import { vpd, type EffectiveConditions } from './indoor-climate.js';

export interface ScheduleInput {
  baseIntervalDays: number;
  droughtTolerance: DroughtTolerance;
  temperatureSensitivity: Sensitivity;
  lightSensitivity: Sensitivity;
  humiditySensitivity: Sensitivity;
  reduceInDormancy: boolean;
  idealMinC: number;
  idealMaxC: number;
  idealHumidityPct: number;
  idealLightRank: number; // 0..3 (low..direct)
  anchor: Date;
  adjustment: number; // per-plant learned multiplier (>0)
  effective: EffectiveConditions; // carries tempSignal/humiditySignal
  placeLightRank: number; // 0..3
  season: Season;
  reduceSeason: Season; // the dormancy season for this hemisphere (typically 'winter')
  // Optional physical inputs (spec A §3.1) — every one nullable/absent, defaulting to a NEUTRAL 1.0
  // factor and 0 confidence weight, so missing data never shifts the schedule (§3.5 invariant 3). Phase 4
  // reads these off the plant's PlantProfile + place.airflow.
  potType?: PotType | null;
  potSizeCm?: number | null;
  airflow?: Airflow | null;
  windowDistance?: WindowDist | null;
  growLight?: boolean | null;
  soilMix?: SoilMix | null;
  hasDrainage?: boolean | null;
  nearHeater?: boolean | null;
  growthHabit?: GrowthHabit | null;
  ageMonths?: number | null;
  // Spec-B feedback coupling (§3.6). Wired here, fed in Spec B. feedbackFactor multiplies the center;
  // feedbackConfidence raises confidence (widening the guardrail). Defaults are neutral (1 / 0).
  feedbackFactor?: number;
  feedbackConfidence?: number;
}

const SENS_WEIGHT: Record<Sensitivity, number> = { low: 0.04, medium: 0.08, high: 0.14 };
const TOLERANCE_SPAN: Record<DroughtTolerance, number> = { low: 0.5, medium: 1.0, high: 1.5 };

// ---- Factor constants (spec A §3.1's two-channel model). TUNABLE numbers; the shape/invariants are
// fixed, the magnitudes are locked by the table-driven tests. A factor < 1 = dries faster (water sooner);
// > 1 = holds water (water later). ----
const POT_MATERIAL: Record<PotType, number> = {
  terracotta: 0.85, 'unglazed-ceramic': 0.85, fabric: 0.82, // porous / breathing → dry faster
  'glazed-ceramic': 1.08, plastic: 1.08, porcelain: 1.08, metal: 1.1, concrete: 1.05, // sealed → hold
  other: 1.0,
};
const POT_REF_CM = 15; // reference pot: neutral size
const AIRFLOW_FACTOR: Record<Airflow, number> = { still: 1.12, some: 1.0, breezy: 0.85 };
const SOIL_FACTOR: Record<SoilMix, number> = {
  'cactus-succulent': 0.85, 'orchid-bark': 0.85, 'semi-hydro': 0.8, // fast-draining
  'peat-based': 1.15, 'coco-coir': 1.12, // water-retentive
  aroid: 1.0, 'all-purpose': 1.0, other: 1.0,
};
// How much MORE (+) / less (−) effective light the windowDistance/growLight refinement implies vs the bare
// place light rank. Only the REFINEMENT lives here (optional channel); the place light LEVEL is the
// always-on placeLightFactor below.
const WINDOW_LIGHT_DELTA: Record<WindowDist, number> = {
  'on-sill': 0.5, 'within-1m': 0.25, '1-to-2m': 0, '2-to-3m': -0.25, 'over-3m': -0.5, outdoors: 0.75,
};
const DRAINAGE_LOW = 1.12; // hasDrainage === false → water lingers
const HEATER_LOW = 0.85; // nearHeater === true → drier microclimate
const HABIT_LOW = 0.95; // large climbing/tree specimen transpires more (kept intentionally weak)
const VPD_REF_KPA = 1.1; // the VPD at which vpdFactor ≈ 1 (a mild, comfortable demand)
const VPD_EXP = 0.5; // softens the response so a tens-of-% VPD swing stays a modest factor
const WIDEN_GAIN = 2; // how fast the safety clamp widens with confidence (§3.4)

// Confidence weights (§3.2) — the OPTIONAL channel only. Dominant drivers highest, habit lowest. The
// always-on signals (VPD, place light level, season, legacy adjustment) are NOT counted here — confidence
// measures only how complete the optional data is. Only the windowDistance/growLight light REFINEMENT is
// counted (W_LIGHT), never the bare place light level.
const W_POT = 3, W_AIRFLOW = 3, W_LIGHT = 3, W_SOIL = 1, W_DRAIN = 1, W_HEATER = 1, W_HABIT = 0.5;
const W_TOTAL = W_POT + W_AIRFLOW + W_LIGHT + W_SOIL + W_DRAIN + W_HEATER + W_HABIT; // 12.5

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const band = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Hotter than ideal → drink sooner; colder → slower. Only when there's a real temperature signal.
function tempModulator(input: ScheduleInput): number {
  if (!input.effective.tempSignal) return 1;
  const { tempC } = input.effective;
  let deviation = 0;
  if (tempC > input.idealMaxC) deviation = -(tempC - input.idealMaxC);
  else if (tempC < input.idealMinC) deviation = input.idealMinC - tempC;
  return clamp(1 + deviation * SENS_WEIGHT[input.temperatureSensitivity] * 0.1, 0.5, 1.6);
}

// Drier than ideal → drink sooner; more humid → slower. Only with a real humidity signal.
// Humidity is in percentage points, so a small factor keeps a tens-of-points gap bounded.
function humidityModulator(input: ScheduleInput): number {
  if (!input.effective.humiditySignal) return 1;
  const deviation = input.idealHumidityPct - input.effective.humidityPct; // + = drier than ideal
  return clamp(1 - deviation * SENS_WEIGHT[input.humiditySensitivity] * 0.04, 0.7, 1.4);
}

// Brighter than ideal → drink sooner; dimmer → slower.
function lightModulator(input: ScheduleInput): number {
  const deviation = input.idealLightRank - input.placeLightRank; // + means dimmer than ideal
  return clamp(1 + deviation * SENS_WEIGHT[input.lightSensitivity], 0.7, 1.4);
}

// ---- Optional-channel factors (each neutral 1.0 when its datum is absent) ----
function potFactor(potType: PotType | null | undefined, potSizeCm: number | null | undefined): number {
  if (potType == null && potSizeCm == null) return 1;
  const material = potType != null ? POT_MATERIAL[potType] : 1;
  const size = potSizeCm != null ? band(1 + (potSizeCm - POT_REF_CM) * 0.015, 0.75, 1.35) : 1;
  return band(material * size, 0.5, 1.5);
}
const airflowFactor = (a: Airflow | null | undefined): number => (a != null ? AIRFLOW_FACTOR[a] : 1);
const soilMixFactor = (s: SoilMix | null | undefined): number => (s != null ? SOIL_FACTOR[s] : 1);
const drainageFactor = (d: boolean | null | undefined): number => (d === false ? DRAINAGE_LOW : 1);
const heaterFactor = (h: boolean | null | undefined): number => (h === true ? HEATER_LOW : 1);
const habitFactor = (g: GrowthHabit | null | undefined): number =>
  g === 'climber' || g === 'tree' ? HABIT_LOW : 1;

// The windowDistance/growLight light REFINEMENT — a NEW optional input (optional channel). Neutral 1.0
// when neither is present. More effective light than the bare place rank implies (delta > 0) → dries
// faster → factor < 1.
function lightRefinementFactor(input: ScheduleInput): number {
  const wd = input.windowDistance != null ? WINDOW_LIGHT_DELTA[input.windowDistance] : 0;
  const gl = input.growLight === true ? 0.5 : 0;
  const delta = wd + gl;
  return band(1 - delta * SENS_WEIGHT[input.lightSensitivity], 0.75, 1.3);
}

// ---- Always-on factors (exponent 1) ----
// VPD replaces the old temp × humidity modulators (§3.1). Neutral 1.0 when NEITHER temp nor humidity is a
// real signal (§3.5 invariant 6) — matching today's "no signal → neutral".
function vpdFactor(input: ScheduleInput): number {
  if (!input.effective.tempSignal && !input.effective.humiditySignal) return 1;
  const d = vpd(input.effective.tempC, input.effective.humidityPct);
  if (d <= 0) return 1.5; // fully saturated air → hold water (upper band)
  return band(Math.pow(VPD_REF_KPA / d, VPD_EXP), 0.6, 1.5);
}

// The place light LEVEL vs the species ideal — this IS today's lightModulator, renamed. Always-on: it is
// a pre-existing, always-live signal, so with no profile data it is byte-identical to today's behaviour.
function placeLightFactor(input: ScheduleInput): number {
  const deviation = input.idealLightRank - input.placeLightRank; // + = dimmer than ideal → water later
  return band(1 + deviation * SENS_WEIGHT[input.lightSensitivity], 0.7, 1.4);
}

// Dormancy (renamed from seasonModulator). Always-on.
function seasonFactor(input: ScheduleInput): number {
  return input.reduceInDormancy && input.season === input.reduceSeason ? 1.5 : 1;
}

// Confidence over the OPTIONAL channel only (§3.2).
function optionalDataConfidence(input: ScheduleInput): number {
  let present = 0;
  if (input.potType != null || input.potSizeCm != null) present += W_POT;
  if (input.airflow != null) present += W_AIRFLOW;
  if (input.windowDistance != null || input.growLight != null) present += W_LIGHT;
  if (input.soilMix != null) present += W_SOIL;
  if (input.hasDrainage != null) present += W_DRAIN;
  if (input.nearHeater != null) present += W_HEATER;
  if (input.growthHabit != null || input.ageMonths != null) present += W_HABIT;
  return present / W_TOTAL;
}
// Probabilistic OR: optional data and justified feedback each RAISE confidence toward 1 (§3.6).
const combineConfidence = (p: number, f: number): number => band(1 - (1 - p) * (1 - f), 0, 1);

export interface WateringPlan {
  days: number;
  effectiveCenter: number;
  confidence: number;
  alwaysOn: number; // vpd × placeLight × season × legacyAdjustment
  optionalFactor: number; // pot × airflow × lightRefinement × soil × drainage × heater × habit × feedback
  perFactor: {
    pot: number; airflow: number; lightRefinement: number; soil: number;
    drainage: number; heater: number; habit: number; feedback: number;
    vpd: number; placeLight: number; season: number; legacyAdjustment: number;
  };
}

// The pure heart of the watering schedule (spec A §3, two-channel model). Exposes the intermediate values
// for the table-driven tests; production callers use computeNextDue (the Date wrapper) below.
export function computeWateringPlan(input: ScheduleInput): WateringPlan {
  const perFactor = {
    // optional channel
    pot: potFactor(input.potType, input.potSizeCm),
    airflow: airflowFactor(input.airflow),
    lightRefinement: lightRefinementFactor(input),
    soil: soilMixFactor(input.soilMix),
    drainage: drainageFactor(input.hasDrainage),
    heater: heaterFactor(input.nearHeater),
    habit: habitFactor(input.growthHabit),
    feedback: input.feedbackFactor ?? 1,
    // always-on channel
    vpd: vpdFactor(input),
    placeLight: placeLightFactor(input),
    season: seasonFactor(input),
    legacyAdjustment: input.adjustment, // full-strength UNTIL Spec B migrates it into feedbackFactor
  };

  // Always-on (exponent 1): pre-existing live signals, NOT dampened by confidence (§3.1).
  const alwaysOn = perFactor.vpd * perFactor.placeLight * perFactor.season * perFactor.legacyAdjustment;
  // Optional (exponent = confidence): new physical + feedback data, partial data → partial authority.
  const optionalFactor =
    perFactor.pot * perFactor.airflow * perFactor.lightRefinement * perFactor.soil *
    perFactor.drainage * perFactor.heater * perFactor.habit * perFactor.feedback;

  const confidence = combineConfidence(optionalDataConfidence(input), input.feedbackConfidence ?? 0);
  const effectiveCenter = input.baseIntervalDays * alwaysOn * Math.pow(optionalFactor, confidence);

  const span = TOLERANCE_SPAN[input.droughtTolerance];
  const widen = 1 + confidence * WIDEN_GAIN; // more confidence → wider safety bound (§3.4)
  const min = Math.max(1, input.baseIntervalDays * (1 - span * 0.5 * widen));
  const max = input.baseIntervalDays * (1 + span * widen);
  const days = Math.round(band(effectiveCenter, min, max));

  return { days, effectiveCenter, confidence, alwaysOn, optionalFactor, perFactor };
}

export function computeNextDue(input: ScheduleInput): Date {
  const raw =
    input.baseIntervalDays *
    input.adjustment *
    tempModulator(input) *
    lightModulator(input) *
    humidityModulator(input) *
    seasonFactor(input);

  const span = TOLERANCE_SPAN[input.droughtTolerance];
  const min = input.baseIntervalDays * (1 - span * 0.5);
  const max = input.baseIntervalDays * (1 + span);
  const days = Math.round(clamp(raw, Math.max(1, min), max));

  return addDays(input.anchor, days);
}

function addDays(anchor: Date, days: number): Date {
  const due = new Date(anchor.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

// Rotation / leaf-cleaning / repotting: pure cadence, no weather/season/drought sensitivity.
export interface CadenceInput {
  cadenceDays: number;
  adjustment: number;
  anchor: Date;
}
export function computeCadenceDue(i: CadenceInput): Date {
  return addDays(i.anchor, Math.round(i.cadenceDays * i.adjustment));
}

// Fertilizing: in-season cadence; OUT of an active season always lengthens — strongly when
// reduceInDormancy is set (true dormancy), mildly otherwise.
const DORMANT_FERTILIZE_FACTOR = 4;
const INACTIVE_FERTILIZE_FACTOR = 2;
export interface FertilizingInput {
  inSeasonFrequencyDays: number;
  adjustment: number;
  anchor: Date;
  season: Season;
  activeSeasons: Season[];
  reduceInDormancy: boolean;
}
export function computeFertilizingDue(i: FertilizingInput): Date {
  const active = i.activeSeasons.includes(i.season);
  const factor = active ? 1 : i.reduceInDormancy ? DORMANT_FERTILIZE_FACTOR : INACTIVE_FERTILIZE_FACTOR;
  return addDays(i.anchor, Math.round(i.inSeasonFrequencyDays * i.adjustment * factor));
}

// Misting: opt-in per species, gated by the place's effective humidity band. Returns null when no
// misting task should exist (avoid; beneficial in a humid room; tolerated outside a dry room).
const MIST_DRY_FACTOR = 0.6; // dry air → mist more often
export interface MistingInput {
  benefit: MistingBenefit;
  baseFrequencyDays: number | null;
  band: 'DRY' | 'NORMAL' | 'HUMID';
  adjustment: number;
  anchor: Date;
}
export function computeMistingDue(i: MistingInput): Date | null {
  if (i.benefit === 'avoid' || i.baseFrequencyDays === null) return null;
  let factor: number | null;
  if (i.benefit === 'beneficial') {
    factor = i.band === 'HUMID' ? null : i.band === 'DRY' ? MIST_DRY_FACTOR : 1;
  } else {
    // tolerated: only earns a task when the room is dry.
    factor = i.band === 'DRY' ? 1 : null;
  }
  if (factor === null) return null;
  return addDays(i.anchor, Math.round(i.baseFrequencyDays * i.adjustment * factor));
}

// Progress is due every Monday: the next Monday STRICTLY AFTER the anchor date. Pure DATE arithmetic
// in UTC (matching @db.Date storage), so there is no timezone off-by-one. Anchor = the last DONE
// PROGRESS occurredOn, else the plant's acquiredOn (resolved by the caller). No weather/season/place
// inputs — Progress is a fixed weekly cadence, independent of species/place/climate.
export function computeProgressDue(anchor: Date): Date {
  const due = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  // getUTCDay(): Sun=0, Mon=1 … Days until the next Monday: ((1 - dow + 7) % 7). If the anchor is
  // itself a Monday that yields 0, so push a full week to keep it STRICTLY after the anchor.
  const add = (1 - due.getUTCDay() + 7) % 7 || 7;
  due.setUTCDate(due.getUTCDate() + add);
  return due;
}
