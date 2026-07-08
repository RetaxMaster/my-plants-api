import { describe, expect, it } from 'vitest';
import {
  computeCadenceDue,
  computeFertilizingDue,
  computeMistingDue,
  computeNextDue,
  computeWateringPlan,
  type ScheduleInput,
  type WateringPlan,
} from './scheduling.js';
import { effectiveConditions, humidityBand, type PlaceClimateInput } from './indoor-climate.js';

const base: ScheduleInput = {
  baseIntervalDays: 10,
  droughtTolerance: 'medium',
  temperatureSensitivity: 'high',
  lightSensitivity: 'low',
  humiditySensitivity: 'high',
  reduceInDormancy: true,
  idealMinC: 18,
  idealMaxC: 27,
  idealHumidityPct: 60,
  idealLightRank: 2, // bright-indirect
  anchor: new Date('2026-06-01'),
  adjustment: 1,
  effective: { tempC: 22, humidityPct: 60, tempSignal: true, humiditySignal: true },
  placeLightRank: 2,
  season: 'summer',
  reduceSeason: 'winter',
};

// A fully-neutral input: no profile, no real weather signal, ideal-equal light. Every factor must be 1.0
// and confidence 0 — the byte-identical backward-compat anchor (§3.5 invariant 1).
const neutral: ScheduleInput = {
  ...base,
  effective: { tempC: 21, humidityPct: 50, tempSignal: false, humiditySignal: false },
};
// Day-count helper (anchor == base.anchor == 2026-06-01). If the file already declares `anchor`/`daysFrom`
// lower down, MOVE that pair up to here so every block below can use it, and delete the duplicate.
const anchor = new Date('2026-06-01');
const daysFrom = (d: Date): number => Math.round((d.getTime() - anchor.getTime()) / 86_400_000);

describe('computeNextDue', () => {
  it('returns anchor + base interval at ideal conditions', () => {
    const due = computeNextDue(base);
    expect(due.toISOString().slice(0, 10)).toBe('2026-06-11');
  });

  it('shortens the interval in hot weather for a temperature-sensitive plant', () => {
    const due = computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 60, tempSignal: true, humiditySignal: true } });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThan(10);
  });

  it('shortens for indoor heat when there is a real temperature signal', () => {
    const due = computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 60, tempSignal: true, humiditySignal: true } });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThan(10);
  });

  it('is neutral on temperature when there is no temperature signal', () => {
    const due = computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 60, tempSignal: false, humiditySignal: true } });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBe(10);
  });

  it('shortens the interval when the air is drier than ideal', () => {
    const dry = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 30, tempSignal: true, humiditySignal: true } });
    const days = Math.round((dry.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThan(10);
  });

  it('lengthens the interval when the air is more humid than ideal', () => {
    const humid = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 85, tempSignal: true, humiditySignal: true } });
    const days = Math.round((humid.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeGreaterThan(10);
  });

  it('is neutral on humidity when there is no humidity signal', () => {
    const due = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 30, tempSignal: true, humiditySignal: false } });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBe(10);
  });

  it('waters a humidity-sensitive plant sooner in a DRY indoor place than in a HUMID one', () => {
    // The DRY (35%) vs HUMID (65%) indoor mapping from effectiveConditions drives the schedule:
    // drier air → drink sooner.
    const dry = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 35, tempSignal: false, humiditySignal: true } });
    const humid = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 65, tempSignal: false, humiditySignal: true } });
    expect(dry.getTime()).toBeLessThan(humid.getTime());
  });

  it('lengthens during dormancy when reduceInDormancy is set', () => {
    const dormant = computeNextDue({ ...base, season: 'winter' });
    const days = Math.round((dormant.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeGreaterThan(10);
  });

  it('applies the per-plant adjustment multiplier', () => {
    const due = computeNextDue({ ...base, adjustment: 1.5 });
    const days = Math.round((due.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBe(15);
  });

  it('clamps to the drought-tolerance bounds', () => {
    const tight = computeNextDue({ ...base, droughtTolerance: 'low', adjustment: 5 });
    const days = Math.round((tight.getTime() - base.anchor.getTime()) / 86_400_000);
    expect(days).toBeLessThanOrEqual(15); // low tolerance caps at base * 1.5
  });
});

describe('computeCadenceDue (rotation / leaf-cleaning / repotting — pure cadence)', () => {
  it('is anchor + cadence, unaffected by weather or season', () => {
    expect(daysFrom(computeCadenceDue({ cadenceDays: 14, adjustment: 1, anchor }))).toBe(14);
  });

  it('applies the per-plant adjustment', () => {
    expect(daysFrom(computeCadenceDue({ cadenceDays: 14, adjustment: 2, anchor }))).toBe(28);
  });
});

describe('computeFertilizingDue (season-aware)', () => {
  it('uses the in-season frequency during an active season', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'summer',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: true,
    });
    expect(daysFrom(due)).toBe(21);
  });

  it('pushes far out when dormant and reduceInDormancy is set', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'winter',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: true,
    });
    expect(daysFrom(due)).toBe(84); // DORMANT factor 4
  });

  it('mildly lengthens out of season when reduceInDormancy is false', () => {
    const due = computeFertilizingDue({
      inSeasonFrequencyDays: 21, adjustment: 1, anchor, season: 'winter',
      activeSeasons: ['spring', 'summer'], reduceInDormancy: false,
    });
    expect(daysFrom(due)).toBe(42); // INACTIVE factor 2
  });
});

const mistBase = {
  benefit: 'beneficial' as const,
  baseFrequencyDays: 4,
  band: 'NORMAL' as const,
  adjustment: 1,
  anchor: new Date('2026-06-01'),
};
const daysFromMist = (d: Date) =>
  Math.round((d.getTime() - mistBase.anchor.getTime()) / 86_400_000);

describe('computeMistingDue', () => {
  it('beneficial + NORMAL → base frequency', () => {
    expect(daysFromMist(computeMistingDue(mistBase)!)).toBe(4);
  });
  it('beneficial + DRY → shortened (more frequent)', () => {
    expect(daysFromMist(computeMistingDue({ ...mistBase, band: 'DRY' })!)).toBeLessThan(4);
  });
  it('beneficial + HUMID → no task', () => {
    expect(computeMistingDue({ ...mistBase, band: 'HUMID' })).toBeNull();
  });
  it('tolerated + DRY → base frequency', () => {
    expect(daysFromMist(computeMistingDue({ ...mistBase, benefit: 'tolerated', band: 'DRY' })!)).toBe(4);
  });
  it('tolerated + NORMAL → no task', () => {
    expect(computeMistingDue({ ...mistBase, benefit: 'tolerated', band: 'NORMAL' })).toBeNull();
  });
  it('tolerated + HUMID → no task', () => {
    expect(computeMistingDue({ ...mistBase, benefit: 'tolerated', band: 'HUMID' })).toBeNull();
  });
  it('avoid → always null', () => {
    expect(computeMistingDue({ ...mistBase, benefit: 'avoid', baseFrequencyDays: null })).toBeNull();
  });
});

// Composes the exact decision the care-plan service delegates to (effective humidity → band →
// misting due) without a DB, so the schedule-vs-clear branch is covered by pure functions. A
// full Prisma-backed service test (upsert/clearDue wiring) is deferred to the E2E phase, since
// the repo has no Prisma service-test harness and the brief forbids inventing a brittle one.
describe('misting band decision (service-equivalent composition)', () => {
  const dryPlace: PlaceClimateInput = {
    indoor: true, climateControlled: false, humidityCharacter: 'DRY',
    indoorTempMinC: null, indoorTempMaxC: null,
  };
  const humidPlace: PlaceClimateInput = { ...dryPlace, humidityCharacter: 'HUMID' };

  it('a beneficial species in a DRY place gets a MIST due', () => {
    const band = humidityBand(effectiveConditions(dryPlace, null).humidityPct);
    expect(band).toBe('DRY');
    expect(computeMistingDue({ ...mistBase, band })).not.toBeNull();
  });

  it('the same species in a HUMID place gets no MIST due (service would clear it)', () => {
    const band = humidityBand(effectiveConditions(humidPlace, null).humidityPct);
    expect(band).toBe('HUMID');
    expect(computeMistingDue({ ...mistBase, band })).toBeNull();
  });
});

describe('computeWateringPlan — per-factor direction, bounds & neutral default', () => {
  it('every factor is 1.0, both channels are 1.0, and confidence is 0 with no optional data and no weather signal', () => {
    const p = computeWateringPlan(neutral);
    expect(p.confidence).toBe(0);
    for (const f of Object.values(p.perFactor)) expect(f).toBe(1);
    expect(p.alwaysOn).toBe(1); // vpd × placeLight × season × legacyAdjustment, all 1 in neutral
    expect(p.optionalFactor).toBe(1);
    expect(p.effectiveCenter).toBe(neutral.baseIntervalDays);
  });

  it('a small porous pot dries faster → potFactor < 1 (shorter)', () => {
    const p = computeWateringPlan({ ...neutral, potType: 'terracotta', potSizeCm: 8 });
    expect(p.perFactor.pot).toBeLessThan(1);
  });

  it('a large sealed pot holds water → potFactor > 1 (longer)', () => {
    const p = computeWateringPlan({ ...neutral, potType: 'plastic', potSizeCm: 35 });
    expect(p.perFactor.pot).toBeGreaterThan(1);
  });

  it('breezy airflow dries faster (<1); still air holds (>1)', () => {
    expect(computeWateringPlan({ ...neutral, airflow: 'breezy' }).perFactor.airflow).toBeLessThan(1);
    expect(computeWateringPlan({ ...neutral, airflow: 'still' }).perFactor.airflow).toBeGreaterThan(1);
  });

  it('a fast-draining mix dries faster (<1); a retentive mix holds (>1)', () => {
    expect(computeWateringPlan({ ...neutral, soilMix: 'cactus-succulent' }).perFactor.soil).toBeLessThan(1);
    expect(computeWateringPlan({ ...neutral, soilMix: 'peat-based' }).perFactor.soil).toBeGreaterThan(1);
  });

  it('no drainage lingers water → drainageFactor > 1', () => {
    expect(computeWateringPlan({ ...neutral, hasDrainage: false }).perFactor.drainage).toBeGreaterThan(1);
    expect(computeWateringPlan({ ...neutral, hasDrainage: true }).perFactor.drainage).toBe(1);
  });

  it('near a heater is a drier microclimate → heaterFactor < 1', () => {
    expect(computeWateringPlan({ ...neutral, nearHeater: true }).perFactor.heater).toBeLessThan(1);
    expect(computeWateringPlan({ ...neutral, nearHeater: false }).perFactor.heater).toBe(1);
  });

  it('a large climbing/tree habit transpires more → habitFactor <= 1', () => {
    expect(computeWateringPlan({ ...neutral, growthHabit: 'climber' }).perFactor.habit).toBeLessThan(1);
    expect(computeWateringPlan({ ...neutral, growthHabit: 'upright' }).perFactor.habit).toBe(1);
  });

  it('thirstier air (high VPD) → vpdFactor < 1; damp air → > 1', () => {
    const hot = computeWateringPlan({ ...base, effective: { tempC: 33, humidityPct: 30, tempSignal: true, humiditySignal: true } });
    const damp = computeWateringPlan({ ...base, effective: { tempC: 18, humidityPct: 85, tempSignal: true, humiditySignal: true } });
    expect(hot.perFactor.vpd).toBeLessThan(1);
    expect(damp.perFactor.vpd).toBeGreaterThan(1);
  });

  it('vpdFactor is exactly 1.0 when neither temp nor humidity is a real signal (§3.5 invariant 6)', () => {
    expect(computeWateringPlan(neutral).perFactor.vpd).toBe(1);
  });

  it('every factor is clamped to its band even for extreme inputs (no absurd multiplier)', () => {
    const p = computeWateringPlan({ ...neutral, potType: 'fabric', potSizeCm: 1 });
    expect(p.perFactor.pot).toBeGreaterThanOrEqual(0.5);
    expect(p.perFactor.pot).toBeLessThanOrEqual(1.5);
  });
});

describe('computeWateringPlan — confidence & effectiveCenter (§3.2–3.4)', () => {
  it('confidence ∈ [0,1] and effectiveCenter lies between the always-on center and the full optional center', () => {
    const p = computeWateringPlan({
      ...base, potType: 'terracotta', potSizeCm: 8, airflow: 'breezy', soilMix: 'cactus-succulent',
      windowDistance: 'on-sill', growLight: true, hasDrainage: true, nearHeater: true, growthHabit: 'climber',
    });
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
    // effectiveCenter = base × alwaysOn × optionalFactor^confidence, so it sits between the confidence-0
    // point (base × alwaysOn) and the confidence-1 point (base × alwaysOn × optionalFactor).
    const alwaysCenter = base.baseIntervalDays * p.alwaysOn;
    const fullOptional = alwaysCenter * p.optionalFactor;
    const lo = Math.min(alwaysCenter, fullOptional);
    const hi = Math.max(alwaysCenter, fullOptional);
    expect(p.effectiveCenter).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(p.effectiveCenter).toBeLessThanOrEqual(hi + 1e-9);
  });

  it('a real weather signal shifts the center at FULL strength but does NOT raise confidence (always-on channel)', () => {
    const p = computeWateringPlan({ ...base, effective: { tempC: 33, humidityPct: 30, tempSignal: true, humiditySignal: true } });
    expect(p.confidence).toBe(0); // VPD is always-on — it is NOT part of the optional channel confidence measures
    expect(p.optionalFactor).toBe(1); // no optional data present
    expect(p.effectiveCenter).toBeLessThan(base.baseIntervalDays); // thirsty air pulls it shorter, full strength
    // Bounded by the vpd factor band [0.6, 1.5]: never more extreme than base × 0.6.
    expect(p.effectiveCenter).toBeGreaterThanOrEqual(base.baseIntervalDays * 0.6 - 1e-9);
  });

  it('feedbackFactor moves the center and feedbackConfidence gives the optional channel authority (one mechanism)', () => {
    const dry = computeWateringPlan({ ...neutral, feedbackFactor: 0.6, feedbackConfidence: 0.8 });
    expect(dry.effectiveCenter).toBeLessThan(neutral.baseIntervalDays); // net dry-soil feedback → sooner
    expect(dry.confidence).toBeGreaterThan(0); // feedbackConfidence raises the optional-channel confidence
    const intuitionOnly = computeWateringPlan({ ...neutral, feedbackFactor: 1, feedbackConfidence: 0 });
    expect(intuitionOnly.effectiveCenter).toBe(neutral.baseIntervalDays); // no justified feedback → moves nothing
  });
});
