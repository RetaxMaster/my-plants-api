import { Injectable } from '@nestjs/common';
import { parseSpeciesRecord, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import type { Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { effectiveConditions, humidityBand, type EffectiveConditions } from '../engines/indoor-climate.js';
import { computeCadenceDue, computeFertilizingDue, computeMistingDue, computeNextDue, computeProgressDue } from '../engines/scheduling.js';
import { hemisphereForLatitude, seasonForDate, type Hemisphere } from '../common/season/season.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';
import { lightRank, placeLightRank } from '../places/place-conditions.js';
import type { Airflow, GrowthHabit, PotType, Season, SoilMix, WindowDist } from '@retaxmaster/my-plants-species-schema';

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

    for (const task of SCHEDULED_TASKS) {
      // ROTATE / CLEAN_LEAVES are optional cadences — skip when the species has none, clearing any
      // stale due so a previously-scheduled cadence does not linger after the species loses it.
      if (task === 'ROTATE' && record.maintenance.rotationDays === null) { await this.clearDue(plantId, task); continue; }
      if (task === 'CLEAN_LEAVES' && record.maintenance.leafCleaningDays === null) { await this.clearDue(plantId, task); continue; }

      const override = plant.overrides.find((o) => o.task === task);
      if (override) {
        await this.upsertDue(plantId, task, override.nextDueOn);
        continue;
      }

      const lastDone = await this.prisma.careEvent.findFirst({
        where: { plantId, task, type: 'DONE' },
        orderBy: { occurredOn: 'desc' },
      });
      const anchor = lastDone?.occurredOn ?? plant.acquiredOn;
      const adjustment = plant.adjustments.find((a) => a.task === task)?.multiplier ?? 1;

      // PlantTaskFrequency override — replaces the species base interval at this seam. The ROTATE/
      // CLEAN_LEAVES skip/clear checks already `continue` above, so an override on a skipped optional
      // task never reaches here (it stays inert — spec §4.5). It tunes how often, never whether.
      const frequencyDays = plant.frequencies.find((f) => f.task === task)?.intervalDays;
      const due = this.dueForTask(task, record, {
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
      }, frequencyDays);
      await this.upsertDue(plantId, task, due);
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
    // REPOT / ROTATE / CLEAN_LEAVES: pure cadence. The override replaces the species cadenceDays.
    const cadenceDays =
      frequencyDays ??
      (task === 'REPOT'
        ? record.repotting.typicalIntervalMonths * 30
        : task === 'ROTATE'
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
