import { describe, expect, it } from 'vitest';
import {
  computeCadenceDue,
  computeFertilizingDue,
  computeMistingDue,
  computeNextDue,
  computeWateringPlan,
  crowdingFactorWater,
  crowdingIndex,
  freshness,
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
  it('is exactly neutral at R = R_REF (normalized form: (1+B)/(1+B) = 1, then ^p, then band)', () => {
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
  it('NO CLIFF: sampling the days either side of every freshness breakpoint moves the interval ≤ 1 day', () => {
    const at = (age: number) => computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: 20, heightCm: 90, heightAgeDays: age }).days;
    for (const bp of [90, 730]) {
      expect(Math.abs(at(bp) - at(bp - 1))).toBeLessThanOrEqual(1);
      expect(Math.abs(at(bp) - at(bp + 1))).toBeLessThanOrEqual(1);
    }
  });
  it('at constant R, crowding is exactly constant and days is monotone NON-DECREASING in pot size', () => {
    // R fixed at 2 (height = 2× pot, upright): only potFactor varies, and it saturates at its band.
    let prev = -Infinity;
    let firstCrowding: number | null = null;
    for (const D of [10, 15, 20, 30, 40, 50]) {
      const plan = computeWateringPlan({ ...neutral, growthHabit: 'upright', potSizeCm: D, heightCm: 2 * D, heightAgeDays: 0 });
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
