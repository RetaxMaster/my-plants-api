import type { DroughtTolerance, MistingBenefit, Season, Sensitivity } from '@retaxmaster/my-plants-species-schema';
import type { EffectiveConditions } from './indoor-climate.js';

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
}

const SENS_WEIGHT: Record<Sensitivity, number> = { low: 0.04, medium: 0.08, high: 0.14 };
const TOLERANCE_SPAN: Record<DroughtTolerance, number> = { low: 0.5, medium: 1.0, high: 1.5 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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

function seasonModulator(input: ScheduleInput): number {
  return input.reduceInDormancy && input.season === input.reduceSeason ? 1.5 : 1;
}

export function computeNextDue(input: ScheduleInput): Date {
  const raw =
    input.baseIntervalDays *
    input.adjustment *
    tempModulator(input) *
    lightModulator(input) *
    humidityModulator(input) *
    seasonModulator(input);

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
