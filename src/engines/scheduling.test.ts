import { describe, expect, it } from 'vitest';
import {
  computeCadenceDue,
  computeFertilizingDue,
  computeMistingDue,
  computeNextDue,
  computeRepotDue,
  computeWateringPlan,
  crowdingFactorRepot,
  crowdingFactorWater,
  crowdingIndex,
  freshness,
  repotOptional,
  R_REF,
  VPD_EXP,
  VPD_REF_KPA,
  type ScheduleInput,
  type WateringPlan,
} from './scheduling.js';
import type { GrowthHabit } from '@retaxmaster/my-plants-species-schema';
import { effectiveConditions, humidityBand, vpd, type PlaceClimateInput } from './indoor-climate.js';
import { deriveFeedback } from './adaptation.js';

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
  // --- Backward-compat golden path: no optional data + NO real weather signal → identical to the
  // pre-change engine (§3.5 invariant 1). Uses the `neutral` fixture (both signals false). ---
  it('golden: returns anchor + base interval at neutral conditions', () => {
    const due = computeNextDue(neutral);
    expect(due.toISOString().slice(0, 10)).toBe('2026-06-11'); // anchor 2026-06-01 + 10
  });

  it('the raw per-plant adjustment NO LONGER moves the WATER schedule (A↔B migration)', () => {
    // The learned value no longer rides the always-on channel as a raw multiplier — WATER ignores it.
    const days = daysFrom(computeNextDue({ ...neutral, adjustment: 1.5 }));
    expect(days).toBe(10); // plain base interval, unaffected by `adjustment`
  });

  it('the learned value now enters through feedbackFactor/feedbackConfidence instead', () => {
    // Full confidence + a >1 factor lengthens the schedule; the optional channel carries the learning now.
    const later = daysFrom(computeNextDue({ ...neutral, feedbackFactor: 1.5, feedbackConfidence: 1 }));
    expect(later).toBe(15); // base × 1 × 1.5^1 = 15
    const sooner = daysFrom(computeNextDue({ ...neutral, feedbackFactor: 0.6, feedbackConfidence: 1 }));
    expect(sooner).toBeLessThan(10);
  });

  it('golden: clamps to the exact drought-tolerance bounds at confidence 0', () => {
    // low tolerance, no signal → widen = 1 → max = base * 1.5 = 15 (today's bound, unwidened). The raw
    // `adjustment` no longer moves WATER (A↔B migration), so we drive the center above the max through the
    // always-on channel instead: winter dormancy (×1.5) + a dim place (light band) → center 16.2 > 15,
    // exercising the clamp while confidence stays 0.
    const days = daysFrom(
      computeNextDue({ ...neutral, droughtTolerance: 'low', season: 'winter', placeLightRank: 0 }),
    );
    expect(days).toBe(15);
  });

  it('golden: lengthens during dormancy when reduceInDormancy is set', () => {
    const days = daysFrom(computeNextDue({ ...neutral, season: 'winter' }));
    expect(days).toBeGreaterThan(10);
  });

  it('golden: a dimmer place still lengthens the interval (light preserved at full strength)', () => {
    // idealLightRank 2, placeLightRank 0 (low light) → longer, exactly as the old lightModulator.
    const days = daysFrom(computeNextDue({ ...neutral, placeLightRank: 0 }));
    expect(days).toBeGreaterThan(10);
  });

  // --- VPD path: with a real weather signal the schedule may re-baseline, but stays bounded. ---
  it('shortens the interval in hot, thirsty air (high VPD)', () => {
    const days = daysFrom(computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 30, tempSignal: true, humiditySignal: true } }));
    expect(days).toBeLessThan(10);
  });

  it('lengthens the interval in cool, damp air (low VPD)', () => {
    const days = daysFrom(computeNextDue({ ...base, effective: { tempC: 18, humidityPct: 88, tempSignal: true, humiditySignal: true } }));
    expect(days).toBeGreaterThan(10);
  });

  it('the VPD replacement is full-strength but bounded by the vpd factor band [0.6, 1.5]', () => {
    // VPD is always-on (exponent 1), so it applies fully — but the factor band caps the shift: the
    // shortest reachable center is base × 0.6 = 6 (with no optional data, confidence 0).
    const days = daysFrom(computeNextDue({ ...base, effective: { tempC: 33, humidityPct: 30, tempSignal: true, humiditySignal: true } }));
    expect(days).toBeGreaterThanOrEqual(5); // bounded below by the vpd band + the confidence-0 clamp floor
    expect(days).toBeLessThan(10);
  });

  it('waters a plant sooner in a DRY indoor place than a HUMID one (VPD direction)', () => {
    const dry = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 35, tempSignal: false, humiditySignal: true } });
    const humid = computeNextDue({ ...base, effective: { tempC: 22, humidityPct: 65, tempSignal: false, humiditySignal: true } });
    expect(dry.getTime()).toBeLessThan(humid.getTime());
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

  it('weights the VPD response by species sensitivity (sensitive reacts more sharply, both directions)', () => {
    // Same room, only the species temp/humidity sensitivity differs. A sensitive species must pull its
    // vpdFactor further from 1 than a rugged one; a 'medium'/'medium' species sits between (and equals the
    // unweighted baseline). Re-uses the previously-vestigial temperature/humiditySensitivity fields.
    // Mild-but-off-reference air, chosen so the vpdFactor stays OFF both band edges [0.6, 1.5] for all
    // three sensitivities — otherwise a saturated factor would hide the ordering.
    const warmDry = { tempC: 26, humidityPct: 50, tempSignal: true, humiditySignal: true };
    const coolDamp = { tempC: 20, humidityPct: 70, tempSignal: true, humiditySignal: true };
    const vpdFor = (s: 'low' | 'medium' | 'high', eff: typeof warmDry) =>
      computeWateringPlan({ ...base, temperatureSensitivity: s, humiditySensitivity: s, effective: eff }).perFactor.vpd;
    // Warm, dry air: every species dries faster (< 1), sensitive most, rugged least.
    expect(vpdFor('high', warmDry)).toBeLessThan(vpdFor('medium', warmDry));
    expect(vpdFor('medium', warmDry)).toBeLessThan(vpdFor('low', warmDry));
    expect(vpdFor('low', warmDry)).toBeLessThan(1);
    // Cool, damp air: every species holds water (> 1), sensitive most, rugged least.
    expect(vpdFor('high', coolDamp)).toBeGreaterThan(vpdFor('medium', coolDamp));
    expect(vpdFor('medium', coolDamp)).toBeGreaterThan(vpdFor('low', coolDamp));
    expect(vpdFor('low', coolDamp)).toBeGreaterThan(1);
    // Backcompat guard: a 'medium'/'medium' species MUST equal the unweighted (VPD_REF/d)^VPD_EXP — the
    // sensitivity weighting is a no-op at medium. Pins the one property the change relies on so a future
    // tweak to VPD_SENS_MULT.medium (or the averaging) can't silently reschedule every medium species.
    expect(vpdFor('medium', warmDry)).toBeCloseTo(Math.pow(VPD_REF_KPA / vpd(26, 50), VPD_EXP), 12);
    expect(vpdFor('medium', coolDamp)).toBeCloseTo(Math.pow(VPD_REF_KPA / vpd(20, 70), VPD_EXP), 12);
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

describe('re-anchored guardrail — nursery vs indoor fern (spec A §3.4)', () => {
  // A fern: base 4 days, low drought tolerance, shade-loving (high light sensitivity), likes humidity.
  const fern: ScheduleInput = {
    ...base,
    baseIntervalDays: 4,
    droughtTolerance: 'low',
    lightSensitivity: 'high',
    idealLightRank: 1, // medium
    anchor: new Date('2026-06-01'),
  };
  const fernDays = (i: ScheduleInput) => daysFrom(computeNextDue(i));

  it('with ZERO data behaves exactly like today: the 0.75×base floor holds (no daily)', () => {
    const days = fernDays({ ...fern, effective: { tempC: 21, humidityPct: 50, tempSignal: false, humiditySignal: false } });
    expect(days).toBeGreaterThanOrEqual(3); // floor = round(4 * 0.75) = 3 — daily is NOT reachable
  });

  it('a nursery fern with rich dries-fast data can legitimately reach ~daily', () => {
    const days = fernDays({
      ...fern,
      potType: 'terracotta', potSizeCm: 8, // small porous pot
      airflow: 'breezy', // moving air
      soilMix: 'cactus-succulent',
      windowDistance: 'on-sill', // high, direct light
      placeLightRank: 3,
      hasDrainage: true, nearHeater: true,
      effective: { tempC: 30, humidityPct: 30, tempSignal: true, humiditySignal: true }, // high VPD
    });
    expect(days).toBeLessThanOrEqual(2); // the guardrail moved WITH the evidence — daily is reachable
  });

  it("an indoor fern with rich holds-water data still forbids daily (rot protection intact)", () => {
    const days = fernDays({
      ...fern,
      potType: 'glazed-ceramic', potSizeCm: 30, // big sealed pot
      airflow: 'still',
      soilMix: 'peat-based',
      windowDistance: '2-to-3m', placeLightRank: 1, // medium light, as ideal
      hasDrainage: true, nearHeater: false,
      effective: { tempC: 20, humidityPct: 70, tempSignal: true, humiditySignal: true }, // low VPD
    });
    expect(days).toBeGreaterThan(2); // daily correctly disallowed
  });
});

describe('feedback crosses the old floor (spec B §3.4)', () => {
  // A fern: base 4, low drought tolerance, no weather signal → today's hard floor is round(4 × 0.75) = 3.
  const fern: ScheduleInput = {
    ...base,
    baseIntervalDays: 4,
    droughtTolerance: 'low',
    anchor: new Date('2026-06-01'),
    effective: { tempC: 21, humidityPct: 50, tempSignal: false, humiditySignal: false },
  };
  const fernDays = (s: { feedbackFactor: number; feedbackConfidence: number }) =>
    daysFrom(computeNextDue({ ...fern, feedbackFactor: s.feedbackFactor, feedbackConfidence: s.feedbackConfidence }));

  it('repeated justified dry-soil early-waterings push the fern below the old 3-day floor (~every 2 days)', () => {
    const signal = deriveFeedback(Array.from({ length: 10 }, () => ({ kind: 'early-water', reason: 'dry-soil' } as const)));
    expect(fernDays(signal)).toBeLessThanOrEqual(2); // crossed the floor — the guardrail moved with the evidence
  });

  it('an intuition-only history reproduces today\'s schedule exactly (no blind shortening)', () => {
    const signal = deriveFeedback(Array.from({ length: 10 }, () => ({ kind: 'early-water', reason: 'intuition' } as const)));
    expect(signal).toEqual({ feedbackFactor: 1, feedbackConfidence: 0 });
    expect(fernDays(signal)).toBe(4); // identical to the zero-feedback base schedule
  });
});

// ===== Spec E, Area A — the crowding index (plant-to-pot ratio) =========================================

describe('crowdingIndex — habit-normalized height/pot ratio (spec A5.1/A5.2)', () => {
  it('is null when height is absent', () => {
    expect(crowdingIndex(null, 20, 'upright')).toBeNull();
  });
  it('is null when pot size is absent', () => {
    expect(crowdingIndex(40, null, 'upright')).toBeNull();
  });
  it('is null for a trailing habit (height is not the relevant dimension)', () => {
    expect(crowdingIndex(40, 20, 'trailing')).toBeNull();
  });
  it('is null when growth habit is absent (cannot pick a normalizer)', () => {
    expect(crowdingIndex(40, 20, null)).toBeNull();
  });
  it('normalizes: upright 40/20 → 2.0 (a typical upright specimen is neutral at R_REF)', () => {
    expect(crowdingIndex(40, 20, 'upright')).toBeCloseTo(2.0, 10);
  });
  it('a rosette inflates the ratio (0.25 reference) — a tall rosette reads as crowded', () => {
    // 21/20 = 1.05 raw → /0.25 = 4.2 normalized (well above R_REF)
    expect(crowdingIndex(21, 20, 'rosette')).toBeCloseTo(4.2, 10);
  });
  it('a tree deflates the ratio (3.0 reference) — trees are meant to tower', () => {
    // 48/20 = 2.4 raw → /3.0 = 0.8 normalized (below R_REF — a short tree, roomy)
    expect(crowdingIndex(48, 20, 'tree')).toBeCloseTo(0.8, 10);
  });
  it('a TYPICAL specimen of every non-trailing habit normalizes to R_REF (no per-class bias)', () => {
    // HABIT_REF ≡ typical(H/D)/R_REF, so typical H/D ÷ HABIT_REF === R_REF for every habit.
    const typical: Record<string, number> = { upright: 2, clumping: 1.5, rosette: 0.5, shrub: 2.5, tree: 6, climber: 5, other: 2 };
    for (const [habit, hd] of Object.entries(typical)) {
      expect(crowdingIndex(hd, 1, habit as GrowthHabit)).toBeCloseTo(2.0, 10);
    }
  });
  it('is monotonically increasing in height and decreasing in pot size', () => {
    const a = crowdingIndex(30, 20, 'upright')!;
    const taller = crowdingIndex(60, 20, 'upright')!;
    const biggerPot = crowdingIndex(30, 40, 'upright')!;
    expect(taller).toBeGreaterThan(a);
    expect(biggerPot).toBeLessThan(a);
  });
});

describe('freshness — height-age authority curve (spec A5.5)', () => {
  it('is exactly 1 for a height measured today', () => {
    expect(Object.is(freshness(0), 1)).toBe(true);
  });
  it('is exactly 1 across the full-trust plateau (≤ 90 days)', () => {
    expect(Object.is(freshness(90), 1)).toBe(true);
  });
  it('is exactly 0 at and past the hard-zero age (≥ 730 days)', () => {
    expect(Object.is(freshness(730), 0)).toBe(true);
    expect(Object.is(freshness(1000), 0)).toBe(true);
  });
  it('is a continuous linear ramp between the breakpoints', () => {
    expect(freshness(410)).toBeCloseTo(0.5, 10); // midpoint of the ramp
    expect(freshness(91)).toBeLessThan(1);
    expect(freshness(91)).toBeGreaterThan(0.99);
    expect(freshness(729)).toBeGreaterThan(0);
    expect(freshness(729)).toBeLessThan(0.01);
  });
  it('clamps negative ages (future-dated) to full trust', () => {
    expect(Object.is(freshness(-5), 1)).toBe(true);
  });
});

describe('crowdingFactorWater — R² reservoir-vs-loss factor, damped (spec A2.5b/A5.3)', () => {
  // RULE EXEMPTION, with its proof. The feature's standing rule is "Object.is only on literally-returned
  // values", and this value flows through `**`. It is nevertheless BIT-EXACT: at r === rRef the quotient
  // r/rRef is exactly 1; 1 ** n === 1 for every finite n; numerator and denominator are then the same
  // float, so their quotient is exactly 1; and Math.pow(1, p) === 1 for every finite p. Verified over
  // 200k random exponents. The pin is safe; every OTHER Object.is in this file is on a genuine literal.
  it('is exactly neutral at R = R_REF (bit-exact: pow(1, p) === 1 for all finite p)', () => {
    expect(Object.is(crowdingFactorWater(R_REF), 1)).toBe(true);
  });
  it('is < 1 for a crowded plant (R > R_REF) and > 1 for a roomy one (R < R_REF)', () => {
    expect(crowdingFactorWater(3)).toBeLessThan(1);
    expect(crowdingFactorWater(1)).toBeGreaterThan(1);
  });
  it('is bounded to [0.75, 1.3]', () => {
    expect(crowdingFactorWater(100)).toBeGreaterThanOrEqual(0.75);
    expect(crowdingFactorWater(0.01)).toBeLessThanOrEqual(1.3);
  });
  it('is a GRADIENT, not a 3-valued enum: distinct, unclipped values across realistic R', () => {
    // Un-clipped window is R ∈ [0.86, 3.19]; sample inside it and assert strictly monotone, strictly
    // inside the band — the root-bound monstera (R≈3) must NOT read the same as a mild case (R≈2.5).
    const samples = [1.5, 2.0, 2.5, 3.0].map(crowdingFactorWater);
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThan(samples[i - 1]);
    expect(crowdingFactorWater(2.5)).toBeGreaterThan(0.75); // ≈0.883, live
    expect(crowdingFactorWater(3.0)).toBeGreaterThan(0.75); // ≈0.784, live
    expect(crowdingFactorWater(2.5)).not.toBeCloseTo(crowdingFactorWater(3.0), 3);
  });
});

// Golden literals captured from `main` (pre-feature) for `{ ...neutral, growthHabit: 'upright',
// potSizeCm: 20 }` — the "pot size, no height" plant, which is almost every real plant. Captured BEFORE
// scheduling.ts was touched; never regenerate them from the new code (that is what makes this a
// backcompat test rather than a tautology).
const GOLDEN_NO_HEIGHT = { days: 10, confidence: 0.28, effectiveCenter: 10.204562030948559 };

describe('WATER crowding in the optional channel (spec A5.3 / A.7)', () => {
  it('scale invariance: crowding reads D only through R — λ a power of two keeps it EXACT', () => {
    const base = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 30 });
    for (const lam of [0.25, 0.5, 2, 4, 8]) {
      const scaled = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20 * lam, heightCm: 30 * lam });
      expect(Object.is(base.perFactor.crowding, scaled.perFactor.crowding)).toBe(true);
    }
  });
  it('BACKCOMPAT: a plant with potSizeCm and NO heightCm is bit-for-bit identical to pre-feature main', () => {
    const plan = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20 });
    expect(Object.is(plan.perFactor.crowding, 1)).toBe(true);
    expect(Object.is(plan.days, GOLDEN_NO_HEIGHT.days)).toBe(true);
    expect(Object.is(plan.confidence, GOLDEN_NO_HEIGHT.confidence)).toBe(true);
    expect(Object.is(plan.effectiveCenter, GOLDEN_NO_HEIGHT.effectiveCenter)).toBe(true);
  });
  it('a stale height (freshness 0) is bit-for-bit identical to no height: crowding ** 0 === 1', () => {
    const stale = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 60, heightAgeDays: 730 });
    const noHeight = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20 });
    expect(Object.is(stale.perFactor.crowding, 1)).toBe(true);
    expect(Object.is(stale.days, noHeight.days)).toBe(true);
    expect(Object.is(stale.effectiveCenter, noHeight.effectiveCenter)).toBe(true);
  });
  it('a FRESH height on a crowded plant is the ONLY population whose interval moves — it shortens', () => {
    const crowded = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 90, heightAgeDays: 0 });
    const noHeight = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20 });
    expect(crowded.perFactor.crowding).toBeLessThan(1);
    expect(crowded.days).toBeLessThan(noHeight.days); // 9 vs 10 — a real, observable move
  });
  it('a trailing habit yields no crowding signal even with a fresh height and a pot size', () => {
    const plan = computeWateringPlan({ ...neutral, growthHabit: 'trailing', potSizeCm: 20, heightCm: 90, heightAgeDays: 0 });
    expect(Object.is(plan.perFactor.crowding, 1)).toBe(true);
  });
  // ⚠️ THIS TEST WAS WRITTEN WRONG ONCE, AND IT MATTERS HOW. The first version sampled `days` at
  // `heightCm: 90, potSizeCm: 20` (R = 4.5) and asserted the interval moved by at most one day. It was
  // vacuous TWICE OVER:
  //   1. R = 4.5 puts crowdingResponse at 0.5744, which the band CLIPS to 0.75. A factor pinned to a band
  //      edge cannot move, so the test observed a quantity held constant by SATURATION, not by continuity.
  //   2. `days` is a rounded step function that absorbs the jump. The hard gate A5.5 rejected in round 4
  //      (`crowdingFactor := 1` past HEIGHT_FRESH_DAYS) gives days(90) = 9, days(91) = 10 — a difference of
  //      exactly 1, which `<= 1` accepts. The only no-cliff test CERTIFIED THE CLIFF.
  // Both fixed below: R = 2.5 sits strictly inside the un-clipped window [0.857, 3.197], and we assert on
  // the FACTOR, which is where the discontinuity would live. Verified numerically: at the age-90
  // breakpoint the shipped continuous curve moves 1.7e-4, the rejected hard gate moves 1.17e-1.
  it('NO CLIFF: the crowding FACTOR is continuous across every freshness breakpoint', () => {
    const cf = (age: number) =>
      computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 50, heightAgeDays: age }).perFactor.crowding;
    // Guard the guard: if a future band change clipped this fixture, the assertions below would pass by
    // saturation and prove nothing. Require the factor to be strictly inside the band, i.e. free to move.
    expect(cf(0)).toBeGreaterThan(0.75);
    expect(cf(0)).toBeLessThan(1.3);
    for (const bp of [90, 730]) {
      expect(Math.abs(cf(bp) - cf(bp - 1))).toBeLessThan(0.01);
      expect(Math.abs(cf(bp) - cf(bp + 1))).toBeLessThan(0.01);
    }
  });
  it('the 0.01 tolerance DISCRIMINATES: the rejected hard gate would break it at the 90-day breakpoint', () => {
    // A no-cliff test is only worth its lines if a cliff fails it. Reconstruct round 4's rejected design
    // (hard freshness gate instead of a continuous exponent) and show the assertion above rejects it.
    const rejectedHardGate = (age: number) => (age <= 90 ? crowdingFactorWater(2.5) : 1);
    expect(Math.abs(rejectedHardGate(91) - rejectedHardGate(90))).toBeGreaterThan(0.01);
  });
  it('at constant R, crowding is exactly constant and days is monotone NON-DECREASING in pot size', () => {
    // R is fixed OFF the neutral point (height = 3× pot ⇒ R = 3, since HABIT_REF.upright is 1). At R = 2
    // the factor would be the trivial neutral 1.0 for every D, and "exactly constant" would say nothing
    // about the response's shape. `3 * D / D` is exact in IEEE-754 for every integer D used here.
    let prev = -Infinity;
    let firstCrowding: number | null = null;
    for (const D of [10, 15, 20, 30, 40, 50]) {
      const plan = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: D, heightCm: 3 * D, heightAgeDays: 0 });
      expect(plan.perFactor.crowding).toBeLessThan(1); // off-neutral: a real, non-trivial value (≈0.784)
      if (firstCrowding === null) firstCrowding = plan.perFactor.crowding;
      else expect(Object.is(plan.perFactor.crowding, firstCrowding)).toBe(true); // exactly constant
      expect(plan.days).toBeGreaterThanOrEqual(prev);
      prev = plan.days;
    }
  });
  it('W_TOTAL is untouched: adding a fresh height does NOT change optionalDataConfidence', () => {
    // The spine of A5.3 — crowding rides on W_POT. Confidence must be identical with and without height.
    const withHeight = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 90, heightAgeDays: 0 });
    const without = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20 });
    expect(Object.is(withHeight.confidence, without.confidence)).toBe(true);
  });
});

// ===== Spec E, Area A — REPOT: the two-channel engine ===================================================

describe('crowdingFactorRepot — R³ biomass-per-volume prior, damped (spec A2.5/A5.4)', () => {
  // Same bit-exactness exemption as crowdingFactorWater's neutral pin above; see the proof there.
  it('is exactly neutral at R = R_REF_plant (bit-exact, for ANY per-plant threshold)', () => {
    expect(Object.is(crowdingFactorRepot(R_REF, R_REF), 1)).toBe(true);
    expect(Object.is(crowdingFactorRepot(5, 5), 1)).toBe(true);
  });
  it('is < 1 for a crowded plant and > 1 for a roomy one — sampled INSIDE the live window', () => {
    // R = 3 and R = 1 both sit OUTSIDE the un-clipped window [1.517, 2.509], so the band would flatten
    // them to 0.82 / 1.18 and the assertion would only prove the band exists and the sign is not
    // inverted. 2.4 and 1.7 are strictly inside, so this actually exercises the R³ response.
    expect(crowdingFactorRepot(2.4, R_REF)).toBeLessThan(1); // ≈0.856
    expect(crowdingFactorRepot(2.4, R_REF)).toBeGreaterThan(0.82); // ...and not resting on the floor
    expect(crowdingFactorRepot(1.7, R_REF)).toBeGreaterThan(1); // ≈1.113
    expect(crowdingFactorRepot(1.7, R_REF)).toBeLessThan(1.18);
  });
  it('is bounded to [0.82, 1.18] — tighter than the watering band (A2.7)', () => {
    expect(crowdingFactorRepot(100, R_REF)).toBe(0.82);
    expect(crowdingFactorRepot(0.01, R_REF)).toBe(1.18);
  });
  it('defaults rRefPlant to the R_REF convention (the Spec F seam is opt-in)', () => {
    expect(Object.is(crowdingFactorRepot(2.3), crowdingFactorRepot(2.3, R_REF))).toBe(true);
  });
  it('honours the R_REF_plant seam: a higher per-plant threshold makes the same R less crowded', () => {
    // Both sides UN-CLIPPED, so this measures the seam's magnitude instead of comparing two band edges
    // (cfR(3,2) and cfR(3,4) are 0.82 and 1.18 — both saturated). The same R = 2.4 reads 0.856 against the
    // R_REF convention and 1.058 against a taller per-plant threshold. An implementation that ignored
    // `rRefPlant` would return the same value twice.
    const againstConvention = crowdingFactorRepot(2.4, 2);
    const againstTaller = crowdingFactorRepot(2.4, 2.6);
    expect(againstConvention).toBeGreaterThan(0.82); // strictly inside the band...
    expect(againstTaller).toBeLessThan(1.18); // ...on both sides
    expect(againstConvention).toBeLessThan(againstTaller);
  });
});

describe('REPOT reads R³, WATER reads R² — REPOT is steeper at neutral (A2.5b / A.7)', () => {
  it('at a point INSIDE both live windows, |repotResp| > |waterResp| (the shared shape ⇒ 1.5× steeper)', () => {
    // r = 2.2 is inside WATER's live [0.86, 3.19] AND REPOT's live [1.52, 2.50]; r·1.02 = 2.244 is still
    // inside both, so neither factor clips. Verified: |waterResp| ≈ 0.01094, |repotResp| ≈ 0.01718.
    const r = 2.2, r1 = r * 1.02;
    const waterResp = Math.abs(Math.log(crowdingFactorWater(r1) / crowdingFactorWater(r)));
    const repotResp = Math.abs(Math.log(crowdingFactorRepot(r1, R_REF) / crowdingFactorRepot(r, R_REF)));
    expect(waterResp).toBeGreaterThan(0); // guard: neither side is clipped, so the comparison has content
    expect(repotResp).toBeGreaterThan(waterResp);
  });
});

describe('repotOptional — confidence-weighted GEOMETRIC MEAN, never a product (spec A5.4 / A.7)', () => {
  // Inputs are within the factor contract ([0.82,1.18] crowding, [0.85,1.15] residual) so the final
  // band() clamp on the geomean path is a no-op and the short-circuits return their literal values.
  it('wc = wr = 0 → exactly 1 (literal short-circuit)', () => {
    expect(Object.is(repotOptional(0.9, 0.9, 0, 0), 1)).toBe(true);
  });
  it('wr = 0 → exactly crowdingFactor (literal, NOT exp((wc·ln cF)/wc))', () => {
    expect(Object.is(repotOptional(0.85, 0.9, 1, 0), 0.85)).toBe(true);
    expect(Object.is(repotOptional(0.85, 0.9, 0.5, 0), 0.85)).toBe(true); // the IEEE-754 trap case
  });
  it('wc = 0 → exactly residualFactor (literal)', () => {
    expect(Object.is(repotOptional(0.9, 1.1, 0, 1), 1.1)).toBe(true);
  });
  it('with equal weights it is the geometric mean, NOT the product', () => {
    const gm = repotOptional(0.9, 0.9, 1, 1);
    expect(gm).toBeCloseTo(0.9, 10); // sqrt(0.81) = 0.9
    expect(gm).not.toBeCloseTo(0.81, 5); // the product would be 0.81
  });
  it('opposing estimators net out toward neutral instead of compounding', () => {
    expect(repotOptional(0.85, 1.15, 1, 1)).toBeCloseTo(Math.sqrt(0.85 * 1.15), 10);
  });
  it('clamps every branch to [0.82, 1.18], including the short-circuits', () => {
    // Defensive: if a future change widens either input's band, the guarantee must not leak.
    expect(repotOptional(0.5, 1, 1, 0)).toBe(0.82);
    expect(repotOptional(1, 1.5, 0, 1)).toBe(1.18);
  });
});

const REPOT_ANCHOR = new Date(Date.UTC(2026, 0, 1));
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

describe('computeRepotDue — two-channel: cadence base × adjustment × optional^confidence (spec A5.4)', () => {
  const repotBase = { cadenceDays: 600, adjustment: 1, anchor: REPOT_ANCHOR };

  it('BACKCOMPAT: wc = wr = 0 (no crowding, no residual) → exactly the species cadence', () => {
    // Even with hostile factors: optional^0 === 1 exactly, and combineConfidence(0,0) === 0 exactly.
    const due = computeRepotDue({ ...repotBase, crowdingFactor: 0.5, residualFactor: 0.5, wc: 0, wr: 0 });
    expect(daysBetween(REPOT_ANCHOR, due)).toBe(600);
  });
  it('BACKCOMPAT: matches computeCadenceDue exactly when there is no evidence', () => {
    const twoChannel = computeRepotDue({ ...repotBase, adjustment: 1.2, crowdingFactor: 1, residualFactor: 1, wc: 0, wr: 0 });
    const cadence = computeCadenceDue({ cadenceDays: 600, adjustment: 1.2, anchor: REPOT_ANCHOR });
    expect(Object.is(twoChannel.getTime(), cadence.getTime())).toBe(true);
  });
  it('the PlantTaskFrequency seam survives: cadenceDays drives the base', () => {
    const due = computeRepotDue({ ...repotBase, cadenceDays: 300, crowdingFactor: 1, residualFactor: 1, wc: 0, wr: 0 });
    expect(daysBetween(REPOT_ANCHOR, due)).toBe(300);
  });
  it('a crowded, well-evidenced plant pulls the date IN (shorter than the base cadence)', () => {
    const due = computeRepotDue({ ...repotBase, crowdingFactor: 0.85, residualFactor: 0.9, wc: 1, wr: 1 });
    expect(daysBetween(REPOT_ANCHOR, due)).toBeLessThan(600);
  });
  it('a roomy, well-evidenced plant pushes the date OUT', () => {
    const due = computeRepotDue({ ...repotBase, crowdingFactor: 1.18, residualFactor: 1.1, wc: 1, wr: 1 });
    expect(daysBetween(REPOT_ANCHOR, due)).toBeGreaterThan(600);
  });
  it('low confidence nudges; it never replaces the species cadence', () => {
    // The evidence is maximally crowded but barely trusted → the date moves a little, not to the band edge.
    const weak = daysBetween(REPOT_ANCHOR, computeRepotDue({ ...repotBase, crowdingFactor: 0.82, residualFactor: 0.85, wc: 0.1, wr: 0 }));
    const strong = daysBetween(REPOT_ANCHOR, computeRepotDue({ ...repotBase, crowdingFactor: 0.82, residualFactor: 0.85, wc: 1, wr: 0 }));
    expect(weak).toBeGreaterThan(strong);
    expect(weak).toBeLessThan(600);
    expect(strong).toBeGreaterThanOrEqual(Math.round(600 * 0.82)); // bounded: evidence nudges, never overrides
  });
});

describe('computeCadenceDue is untouched — ROTATE/CLEAN_LEAVES stay byte-identical (constraint #6)', () => {
  it('rotation cadence is unchanged by this feature', () => {
    const due = computeCadenceDue({ cadenceDays: 14, adjustment: 1, anchor: REPOT_ANCHOR });
    expect(daysBetween(REPOT_ANCHOR, due)).toBe(14);
  });
  it('leaf-cleaning cadence with an adjustment is unchanged by this feature', () => {
    const due = computeCadenceDue({ cadenceDays: 30, adjustment: 1.5, anchor: REPOT_ANCHOR });
    expect(daysBetween(REPOT_ANCHOR, due)).toBe(45);
  });
});
