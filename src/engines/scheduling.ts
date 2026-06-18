import type { DroughtTolerance, Season, Sensitivity } from '@retaxmaster/my-plants-species-schema';
import type { EffectiveConditions } from './indoor-climate.js';

export interface ScheduleInput {
  baseIntervalDays: number;
  droughtTolerance: DroughtTolerance;
  temperatureSensitivity: Sensitivity;
  lightSensitivity: Sensitivity;
  reduceInDormancy: boolean;
  idealMinC: number;
  idealMaxC: number;
  idealLightRank: number; // 0..3 (low..direct)
  anchor: Date;
  adjustment: number; // per-plant learned multiplier (>0)
  effective: EffectiveConditions;
  placeLightRank: number; // 0..3
  isOutdoor: boolean;
  weatherAvailable: boolean; // false → temperature modulator is forced neutral
  season: Season;
  reduceSeason: Season; // the dormancy season for this hemisphere (typically 'winter')
}

const SENS_WEIGHT: Record<Sensitivity, number> = { low: 0.04, medium: 0.08, high: 0.14 };
const TOLERANCE_SPAN: Record<DroughtTolerance, number> = { low: 0.5, medium: 1.0, high: 1.5 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Hotter than ideal → drink sooner (multiplier < 1); colder → slower (> 1). Outdoor only,
// and only when real weather is available — missing weather must be neutral (spec).
function tempModulator(input: ScheduleInput): number {
  if (!input.isOutdoor || !input.weatherAvailable) return 1;
  const { tempC } = input.effective;
  let deviation = 0;
  if (tempC > input.idealMaxC) deviation = -(tempC - input.idealMaxC);
  else if (tempC < input.idealMinC) deviation = input.idealMinC - tempC;
  return clamp(1 + deviation * SENS_WEIGHT[input.temperatureSensitivity] * 0.1, 0.5, 1.6);
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
