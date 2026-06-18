import { Injectable, NotFoundException } from '@nestjs/common';
import { parseSpeciesRecord, LIGHT_LEVELS } from '@retaxmaster/my-plants-species-schema';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { assessViability, type ViabilityResult } from '../engines/viability.js';
import { effectiveConditions } from '../engines/indoor-climate.js';
import { placeLightRank } from '../places/place-conditions.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';

export interface PlantViability extends ViabilityResult {
  plantId: string;
  nickname: string | null;
}

@Injectable()
export class MovingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly weather: WeatherService,
    private readonly carePlan: CarePlanService,
  ) {}

  // What-if: viability of every plant against the target city's weather. Writes nothing.
  async simulate(targetCityId: string): Promise<PlantViability[]> {
    const ownerId = await this.owner.currentOwnerId();
    const city = await this.prisma.city.findFirst({ where: { id: targetCityId, ownerId } });
    if (!city) throw new NotFoundException(`Unknown city: ${targetCityId}`);
    const weather = await this.weather.forCity(city.id, city.latitude, city.longitude);
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
      return { plantId: plant.id, nickname: plant.nickname, ...result };
    });
  }

  async schedule(targetCityId: string, moveOn: string): Promise<{ id: string }> {
    const ownerId = await this.owner.currentOwnerId();
    const city = await this.prisma.city.findFirst({ where: { id: targetCityId, ownerId } });
    if (!city) throw new NotFoundException(`Unknown city: ${targetCityId}`);
    const move = await this.prisma.scheduledMove.create({
      data: { ownerId, targetCityId, moveOn: new Date(moveOn) },
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
