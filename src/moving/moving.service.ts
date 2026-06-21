import { Injectable } from '@nestjs/common';
import { parseSpeciesRecord, LIGHT_LEVELS } from '@retaxmaster/my-plants-species-schema';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { assessViability, type ViabilityResult } from '../engines/viability.js';
import { effectiveConditions } from '../engines/indoor-climate.js';
import { placeLightRank } from '../places/place-conditions.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';
import { roundCoord4 } from '../common/geo/round-coord.js';

export interface PlantViability extends ViabilityResult {
  plantId: string;
  nickname: string | null;
  speciesSlug: string;
}

@Injectable()
export class MovingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly weather: WeatherService,
    private readonly carePlan: CarePlanService,
  ) {}

  // What-if: viability of every plant against an arbitrary geocoded target. Writes nothing.
  async simulate(latitude: number, longitude: number): Promise<PlantViability[]> {
    const ownerId = await this.owner.currentOwnerId();
    const weather = await this.weather.forLocation(`${latitude},${longitude}`, latitude, longitude);
    const plants = await this.prisma.plant.findMany({
      where: { ownerId },
      include: { species: true, place: true },
    });

    return plants.map((plant) => {
      const record = parseSpeciesRecord(plant.species.record);
      const effective = effectiveConditions(
        {
          indoor: plant.place.indoor,
          climateControlled: plant.place.climateControlled,
          humidityCharacter: plant.place.humidityCharacter,
          indoorTempMinC: plant.place.indoorTempMinC,
          indoorTempMaxC: plant.place.indoorTempMaxC,
        },
        weather ? { tempC: weather.tempC, humidityPct: weather.humidityPct } : null,
      );
      const result = assessViability({
        survivalMinC: record.temperature.survivalMinC,
        survivalMaxC: record.temperature.survivalMaxC,
        minLightRank: LIGHT_LEVELS.indexOf(record.light.minimum),
        minHumidityPct: record.humidity.minimumPct,
        seasonalLowC: weather?.seasonalLowC ?? record.temperature.idealMinC,
        seasonalHighC: weather?.seasonalHighC ?? record.temperature.idealMaxC,
        placeLightRank: placeLightRank(plant.place.lightType),
        effectiveHumidityPct: effective.humidityPct,
      });
      return { plantId: plant.id, nickname: plant.nickname, speciesSlug: plant.speciesSlug, ...result };
    });
  }

  // Persists a planned move. Finds-or-creates the owner's destination City by coordinates
  // rounded to 4 decimals (never exact float equality), then schedules the move against it.
  async schedule(
    target: { name: string; latitude: number; longitude: number; timezone: string },
    moveOn: string,
  ): Promise<{ id: string }> {
    const ownerId = await this.owner.currentOwnerId();
    const wantLat = roundCoord4(target.latitude);
    const wantLng = roundCoord4(target.longitude);

    const owned = await this.prisma.city.findMany({ where: { ownerId } });
    let city = owned.find(
      (c) => roundCoord4(c.latitude) === wantLat && roundCoord4(c.longitude) === wantLng,
    );
    if (!city) {
      city = await this.prisma.city.create({
        data: {
          ownerId,
          name: target.name,
          latitude: target.latitude,
          longitude: target.longitude,
          timezone: target.timezone,
        },
      });
    }

    const move = await this.prisma.scheduledMove.create({
      data: { ownerId, targetCityId: city.id, moveOn: new Date(moveOn) },
    });
    return { id: move.id };
  }

  // Applies any move whose date has arrived: target becomes primary, outdoor places repoint to
  // it, then the whole garden recomputes. Idempotent via the `applied` flag.
  async applyDueMoves(now: Date = new Date()): Promise<number> {
    const ownerId = await this.owner.currentOwnerId();
    const primary = await this.prisma.city.findFirst({ where: { ownerId, isPrimary: true } });
    const cutoff = startOfTomorrowUtc(primary?.timezone ?? 'UTC', now);
    const due = await this.prisma.scheduledMove.findMany({
      where: { ownerId, applied: false, moveOn: { lt: cutoff } },
      orderBy: { moveOn: 'asc' },
    });

    for (const move of due) {
      await this.prisma.$transaction(async (tx) => {
        await tx.city.updateMany({ where: { ownerId }, data: { isPrimary: false } });
        await tx.city.update({ where: { id: move.targetCityId }, data: { isPrimary: true } });
        await tx.place.updateMany({ where: { ownerId, indoor: false }, data: { cityId: move.targetCityId } });
        await tx.scheduledMove.update({ where: { id: move.id }, data: { applied: true } });
      });
    }
    if (due.length > 0) await this.carePlan.recomputeAll();
    return due.length;
  }
}
