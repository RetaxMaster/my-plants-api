import { Injectable } from '@nestjs/common';
import { parseSpeciesRecord, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import type { Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { effectiveConditions, humidityBand, type EffectiveConditions } from '../engines/indoor-climate.js';
import {
  computeCadenceDue, computeFertilizingDue, computeMistingDue, computeNextDue, computeProgressDue,
  computeRepotDue, crowdingFactorRepot, crowdingIndex, freshness,
} from '../engines/scheduling.js';
import { deriveFeedback, deriveRepotResidual, type FeedbackWindowEvent, type RepotResidualSignal } from '../engines/adaptation.js';
import {
  calibrateRepotWithCarry, type RepotCycle, type RepotObservation,
} from '../engines/repot-calibration.js';
import { resolveDue } from './resolve-due.js';
import { latestSizedHeight } from '../plants/latest-sized-height.js';
import { hemisphereForLatitude, seasonForDate, type Hemisphere } from '../common/season/season.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';
import { lightRank, placeLightRank } from '../places/place-conditions.js';
import type { Airflow, GrowthHabit, PotType, Season, SoilMix, WindowDist } from '@retaxmaster/my-plants-species-schema';
import { EARLY_WATER_REASONS, WATER_POSTPONE_REASONS } from '@retaxmaster/my-plants-species-schema';

const SCHEDULED_TASKS: Task[] = ['WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES'];

@Injectable()
export class CarePlanService {
  constructor(private readonly prisma: PrismaService, private readonly weather: WeatherService) {}

  async recomputePlant(plantId: string): Promise<void> {
    const plant = await this.prisma.plant.findUniqueOrThrow({
      where: { id: plantId },
      include: { species: true, place: { include: { city: true } }, adjustments: true, overrides: true, frequencies: true, profile: true },
    });
    const record = parseSpeciesRecord(plant.species.record);
    const { place } = plant;
    const { city } = place;
    const weather = await this.weather.forCity(city.id, city.latitude, city.longitude);
    const effective = effectiveConditions(
      {
        indoor: place.indoor,
        climateControlled: place.climateControlled,
        humidityCharacter: place.humidityCharacter,
        indoorTempMinC: place.indoorTempMinC,
        indoorTempMaxC: place.indoorTempMaxC,
      },
      weather ? { tempC: weather.tempC, humidityPct: weather.humidityPct } : null,
    );
    const hemisphere = hemisphereForLatitude(city.latitude);
    const season = seasonForDate(new Date(), hemisphere);

    const waterFeedback = await this.waterFeedbackSignal(plantId);

    // The plant's height (spec E, Area A). `heightAgeDays` drives `freshness`, which damps the crowding
    // factor's authority rather than its value.
    const sized = await latestSizedHeight(this.prisma, plantId);
    const heightCm = sized?.heightCm ?? null;
    const heightAgeDays = sized?.heightAgeDays ?? null;

    // The per-plant crowding threshold, learned from the owner's inspections (spec F §F.5). Until an
    // inspection is routed to the calibration this returns R_REF literally, so a bare plant is bit-for-bit
    // what Spec E alone computed.
    const now = new Date();
    const rRefPlant = await this.repotThreshold(plantId, now);

    for (const task of SCHEDULED_TASKS) {
      // ROTATE / CLEAN_LEAVES are optional cadences — skip when the species has none, clearing any
      // stale due so a previously-scheduled cadence does not linger after the species loses it.
      if (task === 'ROTATE' && record.maintenance.rotationDays === null) { await this.clearDue(plantId, task); continue; }
      if (task === 'CLEAN_LEAVES' && record.maintenance.leafCleaningDays === null) { await this.clearDue(plantId, task); continue; }

      // NO early short-circuit here, and NO `task !== 'REPOT'` conditional: `resolveDue` is the ONLY place
      // that knows floor-vs-replace (spec F3.1). For a non-REPOT task WITH an override, resolveDue returns
      // the override Date (REPLACE) — bit-for-bit the value the old short-circuit wrote — at the cost of one
      // extra pure dueForTask call. That is precisely what makes resolveDue's REPLACE branch REACHABLE in
      // production, so the seam is one dispatched implementation rather than a fork.
      const override = plant.overrides.find((o) => o.task === task);

      // The scheduling anchor. The `createdAt` tiebreak matches plants.service.ts's `lastRepot` query, so
      // the anchor and `derived.lastRepottedOn` can never disagree on which of two same-day DONE events
      // wins. `occurredOn` is `@db.Date` (day granularity), so same-day events genuinely tie — and Spec F's
      // calibration reads `R_obs` from THAT event's payload, so a non-deterministic winner would silently
      // pick a different observation on every recompute.
      const lastDone = await this.prisma.careEvent.findFirst({
        where: { plantId, task, type: 'DONE' },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
      });
      const anchor = lastDone?.occurredOn ?? plant.acquiredOn;
      const adjustment = plant.adjustments.find((a) => a.task === task)?.multiplier ?? 1;

      // PlantTaskFrequency override — replaces the species base interval at this seam. The ROTATE/
      // CLEAN_LEAVES skip/clear checks already `continue` above, so an override on a skipped optional
      // task never reaches here (it stays inert — spec §4.5). It tunes how often, never whether.
      // REPOT's optional channel (spec E, A5.4): the crowding PRIOR (R³, habit-normalized, freshness-
      // weighted) and the watering model's measured RESIDUAL, windowed to events strictly after the last
      // REPOT DONE so a repot resets the evidence. `wc` is 0 whenever R is not computable — including a
      // fresh height with no pot size, which is load-bearing for Spec F's fallback routing.
      let repotCrowdingFactor = 1;
      let repotResidualFactor = 1;
      let repotWc = 0;
      let repotWr = 0;
      if (task === 'REPOT') {
        const r = crowdingIndex(
          heightCm,
          plant.profile?.potSizeCm ?? null,
          (plant.profile?.growthHabit ?? null) as GrowthHabit | null,
        );
        if (r != null) {
          repotCrowdingFactor = crowdingFactorRepot(r, rRefPlant); // Spec F: the per-plant threshold
          repotWc = freshness(heightAgeDays ?? 0);
        }
        const resid = await this.repotResidualSignal(plantId, anchor);
        repotResidualFactor = resid.residualFactor;
        repotWr = resid.residualConfidence;
      }

      // F6.0a: `payload.routedTo` stops any single EVENT feeding both channels, but it cannot stop a PLANT
      // from accumulating both — two years of stale-height inspections teach the fallback multiplier, and
      // then the owner records a height and the calibration comes alive too. Nothing unlearns the
      // multiplier: it is persistent and never decays. So when the physical channel goes live, the
      // fallback SURRENDERS AUTHORITY in proportion. The persisted multiplier is NOT mutated (it is the
      // owner's accumulated evidence, still valid if the height goes stale again) — only its authority is
      // scaled, by the same freshness that scales the crowding factor's.
      const repotAdjustmentEffective = 1 + (adjustment - 1) * (1 - repotWc);

      const frequencyDays = plant.frequencies.find((f) => f.task === task)?.intervalDays;
      const computed = this.dueForTask(task, record, {
        effective,
        placeLightRank: placeLightRank(place.lightType),
        season,
        anchor,
        adjustment,
        // Optional physical profile + place airflow → the confidence-blended watering center (spec A §3).
        // Enum columns store validated slugs, so the string→union casts are sound (same as toProfileView).
        potType: (plant.profile?.potType ?? null) as PotType | null,
        potSizeCm: plant.profile?.potSizeCm ?? null,
        airflow: (place.airflow ?? null) as Airflow | null,
        windowDistance: (plant.profile?.windowDistance ?? null) as WindowDist | null,
        growLight: plant.profile?.growLight ?? null,
        soilMix: (plant.profile?.soilMix ?? null) as SoilMix | null,
        hasDrainage: plant.profile?.hasDrainage ?? null,
        nearHeater: plant.profile?.nearHeater ?? null,
        growthHabit: (plant.profile?.growthHabit ?? null) as GrowthHabit | null,
        ageMonths: plant.profile?.ageMonths ?? null,
        heightCm,
        heightAgeDays,
        feedbackFactor: task === 'WATER' ? waterFeedback.feedbackFactor : undefined,
        feedbackConfidence: task === 'WATER' ? waterFeedback.feedbackConfidence : undefined,
        repotCrowdingFactor,
        repotResidualFactor,
        repotWc,
        repotWr,
        repotAdjustmentEffective,
      }, frequencyDays);
      await this.upsertDue(plantId, task, resolveDue(task, computed, override?.nextDueOn ?? null));
    }

    // Misting (sixth cycle): humidity-graded, may produce no task at all.
    const mistOverride = plant.overrides.find((o) => o.task === 'MIST');
    if (mistOverride) {
      await this.upsertDue(plantId, 'MIST', mistOverride.nextDueOn);
    } else {
      const mistAnchor =
        (await this.prisma.careEvent.findFirst({
          where: { plantId, task: 'MIST', type: 'DONE' },
          orderBy: { occurredOn: 'desc' },
        }))?.occurredOn ?? plant.acquiredOn;
      const mistAdjustment = plant.adjustments.find((a) => a.task === 'MIST')?.multiplier ?? 1;
      const band = humidityBand(effective.humidityPct);
      // Species-based decision FIRST: null here means misting is skipped for this plant/place, so any
      // MIST frequency override is inert (it tunes how often, never whether).
      const speciesMistDue = computeMistingDue({
        benefit: record.misting.benefit,
        baseFrequencyDays: record.misting.baseFrequencyDays,
        band,
        adjustment: mistAdjustment,
        anchor: mistAnchor,
      });
      if (speciesMistDue === null) {
        await this.clearDue(plantId, 'MIST');
      } else {
        const mistFreq = plant.frequencies.find((f) => f.task === 'MIST')?.intervalDays;
        const mistDue = mistFreq
          ? computeMistingDue({
              benefit: record.misting.benefit,
              baseFrequencyDays: mistFreq, // substitute only once the task is known to be active
              band,
              adjustment: mistAdjustment,
              anchor: mistAnchor,
            })
          : speciesMistDue;
        await this.upsertDue(plantId, 'MIST', mistDue ?? speciesMistDue);
      }
    }

    // Progress (seventh cycle): fixed weekly Monday cadence. ALWAYS present — never skipped, never
    // species-gated. Deliberately does NOT read overrides, adjustments, modulators, or the frequency
    // seam above (its cadence is a plain rule; a stray Postpone must never pin it). Anchor = last DONE
    // PROGRESS occurredOn, else acquiredOn (same anchor rule as every other task).
    const progressAnchor =
      (await this.prisma.careEvent.findFirst({
        where: { plantId, task: 'PROGRESS', type: 'DONE' },
        orderBy: { occurredOn: 'desc' },
      }))?.occurredOn ?? plant.acquiredOn;
    await this.upsertDue(plantId, 'PROGRESS', computeProgressDue(progressAnchor));
  }

  // The plant's last-10 reason/symptom-bearing WATER feedback events, distilled into Spec A §3.6's
  // optional-channel signal (spec B §3.3/§3.4). We fetch WATER feedback newest-first and classify + slice
  // to the 10 most recent reason/symptom-bearing events in JS (payload JSON is parsed in JS, never via a
  // brittle MySQL JSON path — same pattern the old adaptFromPunctuality used). Only reason/symptom-bearing
  // events enter the window; plain due waterings (no reason) are ignored, so a run of recent intuition
  // waterings correctly dilutes older dry-soil.
  //
  // Deliberately NO fixed row cap (`take`): the spec defines the window by reason-bearing COUNT (10), not
  // by raw-event count. Every plain on-time watering also writes a DONE CareEvent (adherence, no reason),
  // so a fixed cap of N raw rows would let a run of >N plain waterings evict still-relevant reason-bearing
  // events out of the fetch — silently reverting a frequently-watered plant (e.g. a fern watered every few
  // days) to the species base and destroying its learning. Unbounded is safe at our single-user scale: a
  // two-column projection over one plant's lifetime WATER events is tiny, and the JS loop stops at 10
  // reason-bearing matches regardless of how many plain rows precede them.
  private async waterFeedbackSignal(plantId: string): Promise<{ feedbackFactor: number; feedbackConfidence: number }> {
    return deriveFeedback(await this.waterFeedbackWindow(plantId));
  }

  // Fold the plant's REPOT inspection history into a per-plant crowding threshold `R_REF_plant` (spec F5.2b
  // / F5.3). We read ALL REPOT events oldest-first — the `DONE`s are cycle boundaries, the `POSTPONED`s are
  // inspections — and consume ONLY `payload.routedTo === 'calibration'` events.
  //
  // That filter IS the mechanism, not an optimisation. `adapt()` writes the fallback multiplier ONCE, at
  // submit time; this calibration is a pure function of the event history, re-evaluated on EVERY recompute.
  // So a fallback-routed inspection still carries its `R_obs` in the payload, and without the `routedTo`
  // check the very next recompute would feed it to the calibration as well: one event, both channels.
  //
  // A `REPOT` `DONE` is NOT an observation (F.10 item 4). A preventive or merely scheduled repot would enter
  // the estimate as a false `needed` and poison it. `routedTo: 'done'` excludes it structurally.
  //
  // Legacy events (every REPOT event in production today) carry no `reason` and no `routedTo`, so they are
  // skipped here and the estimator short-circuits to `R_REF` literally.
  //
  // `ageDays` for `σ_obs` is the HEIGHT MEASUREMENT's age, measured to now — never the inspection event's.
  private async repotThreshold(plantId: string, now: Date): Promise<number> {
    const events = await this.prisma.careEvent.findMany({
      where: { plantId, task: 'REPOT', type: { in: ['DONE', 'POSTPONED'] } },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
      select: { type: true, occurredOn: true, payload: true },
    });
    const yearsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (365 * 86_400_000);
    const cycles: RepotCycle[] = [];
    let current: RepotObservation[] = [];
    for (const e of events) {
      if (e.type === 'DONE') {
        // A repot closes the cycle. Its posterior is carried forward as the next cycle's prior, widened by
        // the elapsed time — a repot is a physical reset, not amnesia (F5.2b).
        cycles.push({ obs: current, doneYearsAgo: Math.max(0, yearsBetween(e.occurredOn, now)) });
        current = [];
        continue;
      }
      const p = e.payload as {
        routedTo?: string; reason?: string; R_obs?: number | null; heightMeasuredOn?: string | null;
      } | null;
      if (p?.routedTo !== 'calibration' || p.R_obs == null) continue; // ONLY calibration-routed inspections
      const kind =
        p.reason === 'not-needed-yet' ? 'not-needed' : p.reason === 'needed-cannot-now' ? 'needed' : null;
      if (kind == null) continue;
      const ageDays = p.heightMeasuredOn
        ? Math.max(0, Math.floor((now.getTime() - new Date(p.heightMeasuredOn).getTime()) / 86_400_000))
        : 0;
      current.push({ kind, R: p.R_obs, ageDays });
    }
    cycles.push({ obs: current, doneYearsAgo: null }); // the open cycle
    // The posterior's sharpness `w` is deliberately NOT consumed here. It measures how well we know this
    // plant's threshold; `wc` measures how much we trust TODAY's height. They are different quantities on
    // different scales, and Spec E A5.4 forbids feeding both into the binary noisy-OR. Surfacing `w` in the
    // UI is F.10 item 13 — deferred.
    return calibrateRepotWithCarry(cycles).est;
  }

  // The SAME watering-feedback window, read as a root-bound signal for REPOT (spec E, A2.8/A5.4). The only
  // difference is where the window starts: at the REPOT anchor — the last REPOT DONE, or `acquiredOn` for
  // a plant that has never been repotted. A repot therefore RESETS the evidence; otherwise, the day after
  // a repot, ten pre-repot dry-soil events would still testify that the plant is root-bound. Because
  // `occurredOn` is a DATE column, `gt` also excludes waterings recorded ON the repot day itself, which is
  // what we want: they describe the old root ball. One window implementation, an injected lower bound.
  private async repotResidualSignal(plantId: string, sinceExclusive: Date): Promise<RepotResidualSignal> {
    return deriveRepotResidual(await this.waterFeedbackWindow(plantId, sinceExclusive));
  }

  // The single row→window mapping shared by both signals above. `sinceExclusive` is bound as a native Date
  // (never an ISO string — MariaDB would parse it in the session timezone and shift the day boundary).
  private async waterFeedbackWindow(plantId: string, sinceExclusive?: Date): Promise<FeedbackWindowEvent[]> {
    const rows = await this.prisma.careEvent.findMany({
      where: {
        plantId,
        task: 'WATER',
        type: { in: ['DONE', 'POSTPONED', 'SYMPTOM'] },
        ...(sinceExclusive ? { occurredOn: { gt: sinceExclusive } } : {}),
      },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
      select: { type: true, payload: true },
    });
    const window: FeedbackWindowEvent[] = [];
    for (const r of rows) {
      const p = r.payload as { reason?: string; symptom?: string } | null;
      if (r.type === 'DONE' && p?.reason && (EARLY_WATER_REASONS as readonly string[]).includes(p.reason)) {
        window.push({ kind: 'early-water', reason: p.reason });
      } else if (r.type === 'POSTPONED' && p?.reason && (WATER_POSTPONE_REASONS as readonly string[]).includes(p.reason)) {
        window.push({ kind: 'postpone', reason: p.reason });
      } else if (r.type === 'SYMPTOM' && p?.symptom) {
        window.push({ kind: 'symptom', symptom: p.symptom });
      }
      // last-10 (spec B §3.3), newest-first. Without this slice, "every event since the last REPOT DONE"
      // is up to 24 months: a fern watered every 3–4 days would saturate the residual within weeks and
      // pin its repot date for the whole cycle.
      if (window.length >= 10) break;
    }
    return window;
  }

  private dueForTask(
    task: Task,
    record: SpeciesRecord,
    ctx: {
      effective: EffectiveConditions;
      placeLightRank: number;
      season: Season;
      anchor: Date;
      adjustment: number;
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
      heightCm?: number | null;
      heightAgeDays?: number | null;
      feedbackFactor?: number;
      feedbackConfidence?: number;
      // REPOT's optional channel (spec E, A5.4) — neutral (1 / 1 / 0 / 0) for every other task.
      repotCrowdingFactor?: number;
      repotResidualFactor?: number;
      repotWc?: number;
      repotWr?: number;
      // `adjustment` scaled by (1 - wc) — spec F6.0a. REPOT reads this INSTEAD of `adjustment`; every other
      // task reads `adjustment` and never sees this field.
      repotAdjustmentEffective?: number;
    },
    frequencyDays?: number, // PlantTaskFrequency override — replaces the species base interval
  ): Date {
    if (task === 'WATER') {
      return computeNextDue({
        baseIntervalDays: frequencyDays ?? record.watering.baseIntervalDays,
        droughtTolerance: record.watering.droughtTolerance,
        temperatureSensitivity: record.watering.temperatureSensitivity,
        lightSensitivity: record.watering.lightSensitivity,
        humiditySensitivity: record.watering.humiditySensitivity,
        reduceInDormancy: record.watering.reduceInDormancy,
        idealMinC: record.temperature.idealMinC,
        idealMaxC: record.temperature.idealMaxC,
        idealHumidityPct: record.humidity.idealPct,
        idealLightRank: lightRank(record.light.ideal),
        anchor: ctx.anchor,
        adjustment: ctx.adjustment,
        effective: ctx.effective,
        placeLightRank: ctx.placeLightRank,
        season: ctx.season,
        reduceSeason: 'winter',
        potType: ctx.potType,
        potSizeCm: ctx.potSizeCm,
        airflow: ctx.airflow,
        windowDistance: ctx.windowDistance,
        growLight: ctx.growLight,
        soilMix: ctx.soilMix,
        hasDrainage: ctx.hasDrainage,
        nearHeater: ctx.nearHeater,
        growthHabit: ctx.growthHabit,
        ageMonths: ctx.ageMonths,
        heightCm: ctx.heightCm,
        heightAgeDays: ctx.heightAgeDays,
        feedbackFactor: ctx.feedbackFactor,
        feedbackConfidence: ctx.feedbackConfidence,
      });
    }
    if (task === 'FERTILIZE') {
      return computeFertilizingDue({
        inSeasonFrequencyDays: frequencyDays ?? record.fertilizing.inSeasonFrequencyDays,
        adjustment: ctx.adjustment,
        anchor: ctx.anchor,
        season: ctx.season,
        activeSeasons: record.fertilizing.activeSeasons,
        reduceInDormancy: record.fertilizing.reduceInDormancy,
      });
    }
    // REPOT: two-channel (spec E, A5.4) — the species cadence is the always-on base; crowding + the
    // watering residual ride an optional, evidence-weighted channel. ROTATE / CLEAN_LEAVES stay on
    // computeCadenceDue, untouched, so they cannot drift.
    if (task === 'REPOT') {
      return computeRepotDue({
        cadenceDays: frequencyDays ?? record.repotting.typicalIntervalMonths * 30,
        // The FALLBACK multiplier, with its authority surrendered in proportion to the physical channel's
        // freshness (F6.0a). Falls back to the raw `adjustment` only if the field was not threaded.
        adjustment: ctx.repotAdjustmentEffective ?? ctx.adjustment,
        anchor: ctx.anchor,
        crowdingFactor: ctx.repotCrowdingFactor ?? 1,
        residualFactor: ctx.repotResidualFactor ?? 1,
        wc: ctx.repotWc ?? 0,
        wr: ctx.repotWr ?? 0,
      });
    }
    // ROTATE / CLEAN_LEAVES: pure cadence. The override replaces the species cadenceDays.
    const cadenceDays =
      frequencyDays ??
      (task === 'ROTATE'
        ? (record.maintenance.rotationDays as number)
        : (record.maintenance.leafCleaningDays as number));
    return computeCadenceDue({ cadenceDays, adjustment: ctx.adjustment, anchor: ctx.anchor });
  }

  async recomputeAll(): Promise<void> {
    const plants = await this.prisma.plant.findMany({ select: { id: true } });
    for (const p of plants) await this.recomputePlant(p.id);
  }

  // Recompute only one owner's plants — the owner-scoped form of recomputeAll. The HTTP recompute
  // endpoint always uses this (scoped to the effective owner); recomputeAll is system-jobs only
  // (cron/startup/moving), never reachable over HTTP.
  async recomputeOwner(ownerId: string): Promise<void> {
    const plants = await this.prisma.plant.findMany({ where: { ownerId }, select: { id: true } });
    for (const p of plants) await this.recomputePlant(p.id);
  }

  // Recompute every plant in one place — used when a place's climate-affecting fields change.
  async recomputePlace(placeId: string): Promise<void> {
    const plants = await this.prisma.plant.findMany({ where: { placeId }, select: { id: true } });
    for (const p of plants) await this.recomputePlant(p.id);
  }

  // "Today" derives the day boundary from EACH plant's place-city timezone (not a single primary).
  // Due dates are DATE granularity; we filter per row with native Date comparisons (MariaDB date rule).
  async todaysTasks(ownerId: string, now: Date = new Date()): Promise<{ plantId: string; task: Task; nextDueOn: Date }[]> {
    const rows = await this.prisma.dueCache.findMany({
      where: { plant: { ownerId } },
      select: {
        plantId: true,
        task: true,
        nextDueOn: true,
        plant: { select: { place: { select: { city: { select: { timezone: true } } } } } },
      },
      orderBy: { nextDueOn: 'asc' },
    });
    return rows
      .filter((r) => r.nextDueOn < startOfTomorrowUtc(r.plant.place.city.timezone, now))
      .map((r) => ({ plantId: r.plantId, task: r.task, nextDueOn: r.nextDueOn }));
  }

  private async upsertDue(plantId: string, task: Task, nextDueOn: Date): Promise<void> {
    await this.prisma.dueCache.upsert({
      where: { plantId_task: { plantId, task } },
      create: { plantId, task, nextDueOn },
      update: { nextDueOn, computedAt: new Date() },
    });
  }

  private async clearDue(plantId: string, task: Task): Promise<void> {
    await this.prisma.dueCache.deleteMany({ where: { plantId, task } });
  }
}
