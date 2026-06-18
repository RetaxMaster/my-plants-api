import { Injectable } from '@nestjs/common';
import { parseSpeciesRecord, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import type { Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { effectiveConditions, type EffectiveConditions } from '../engines/indoor-climate.js';
import { computeCadenceDue, computeFertilizingDue, computeNextDue } from '../engines/scheduling.js';
import { hemisphereForLatitude, seasonForDate, type Hemisphere } from '../common/season/season.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';
import { lightRank, placeLightRank } from '../places/place-conditions.js';
import type { Season } from '@retaxmaster/my-plants-species-schema';

const SCHEDULED_TASKS: Task[] = ['WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES'];

@Injectable()
export class CarePlanService {
  constructor(private readonly prisma: PrismaService, private readonly weather: WeatherService) {}

  async recomputePlant(plantId: string): Promise<void> {
    const plant = await this.prisma.plant.findUniqueOrThrow({
      where: { id: plantId },
      include: { species: true, place: { include: { city: true } }, adjustments: true, overrides: true },
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
      // ROTATE / CLEAN_LEAVES are optional cadences — skip when the species has none.
      if (task === 'ROTATE' && record.maintenance.rotationDays === null) continue;
      if (task === 'CLEAN_LEAVES' && record.maintenance.leafCleaningDays === null) continue;

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

      const due = this.dueForTask(task, record, { effective, weatherAvailable: weather !== null, isOutdoor: !place.indoor, placeLightRank: placeLightRank(place.lightType), season, anchor, adjustment });
      await this.upsertDue(plantId, task, due);
    }
  }

  private dueForTask(
    task: Task,
    record: SpeciesRecord,
    ctx: {
      effective: EffectiveConditions;
      weatherAvailable: boolean;
      isOutdoor: boolean;
      placeLightRank: number;
      season: Season;
      anchor: Date;
      adjustment: number;
    },
  ): Date {
    if (task === 'WATER') {
      return computeNextDue({
        baseIntervalDays: record.watering.baseIntervalDays,
        droughtTolerance: record.watering.droughtTolerance,
        temperatureSensitivity: record.watering.temperatureSensitivity,
        lightSensitivity: record.watering.lightSensitivity,
        reduceInDormancy: record.watering.reduceInDormancy,
        idealMinC: record.temperature.idealMinC,
        idealMaxC: record.temperature.idealMaxC,
        idealLightRank: lightRank(record.light.ideal),
        anchor: ctx.anchor,
        adjustment: ctx.adjustment,
        effective: ctx.effective,
        placeLightRank: ctx.placeLightRank,
        isOutdoor: ctx.isOutdoor,
        weatherAvailable: ctx.weatherAvailable,
        season: ctx.season,
        reduceSeason: 'winter',
      });
    }
    if (task === 'FERTILIZE') {
      return computeFertilizingDue({
        inSeasonFrequencyDays: record.fertilizing.inSeasonFrequencyDays,
        adjustment: ctx.adjustment,
        anchor: ctx.anchor,
        season: ctx.season,
        activeSeasons: record.fertilizing.activeSeasons,
        reduceInDormancy: record.fertilizing.reduceInDormancy,
      });
    }
    // REPOT / ROTATE / CLEAN_LEAVES: pure cadence.
    const cadenceDays =
      task === 'REPOT'
        ? record.repotting.typicalIntervalMonths * 30
        : task === 'ROTATE'
          ? (record.maintenance.rotationDays as number)
          : (record.maintenance.leafCleaningDays as number);
    return computeCadenceDue({ cadenceDays, adjustment: ctx.adjustment, anchor: ctx.anchor });
  }

  async recomputeAll(): Promise<void> {
    const plants = await this.prisma.plant.findMany({ select: { id: true } });
    for (const p of plants) await this.recomputePlant(p.id);
  }

  // "Today" uses the owner's primary-city timezone; due dates are DATE granularity.
  async todaysTasks(ownerId: string): Promise<{ plantId: string; task: Task; nextDueOn: Date }[]> {
    const primary = await this.prisma.city.findFirst({ where: { ownerId, isPrimary: true } });
    const tz = primary?.timezone ?? 'UTC';
    const end = startOfTomorrowUtc(tz);
    return this.prisma.dueCache.findMany({
      where: { nextDueOn: { lt: end }, plant: { ownerId } },
      select: { plantId: true, task: true, nextDueOn: true },
      orderBy: { nextDueOn: 'asc' },
    });
  }

  private async upsertDue(plantId: string, task: Task, nextDueOn: Date): Promise<void> {
    await this.prisma.dueCache.upsert({
      where: { plantId_task: { plantId, task } },
      create: { plantId, task, nextDueOn },
      update: { nextDueOn, computedAt: new Date() },
    });
  }
}
