import { Injectable } from '@nestjs/common';
import { parseSpeciesRecord, primaryCommonName } from '@retaxmaster/my-plants-species-schema';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { buildViability, type ViabilityResult } from '../engines/viability.js';
import { startOfTomorrowUtc } from '../common/time/local-date.js';
import { roundCoord4 } from '../common/geo/round-coord.js';

export interface PlantViability extends ViabilityResult {
  plantId: string;
  nickname: string | null;
  speciesSlug: string;
  speciesScientificName: string;
  speciesCommonName: string;
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
  // Stays on currentOwnerId() (NOT ownerFilter): "simulate MY garden against a location". With {}
  // an ADMIN would simulate viability across EVERY owner's plants, which is not the feature's intent.
  async simulate(latitude: number, longitude: number): Promise<PlantViability[]> {
    const ownerId = this.owner.currentOwnerId();
    const weather = await this.weather.forLocation(`${latitude},${longitude}`, latitude, longitude);
    // Scope to the plants actually at the current (primary) city — plants in other cities are not
    // "with you". No-primary fallback: simulate all owner plants (today's backward-compatible behavior).
    const primary = await this.prisma.city.findFirst({ where: { ownerId, isPrimary: true } });
    const where = primary ? { ownerId, place: { cityId: primary.id } } : { ownerId };
    const plants = await this.prisma.plant.findMany({
      where,
      include: { species: true, place: true },
    });

    return plants.map((plant) => {
      const record = parseSpeciesRecord(plant.species.record);
      const result = buildViability(
        record,
        {
          indoor: plant.place.indoor,
          climateControlled: plant.place.climateControlled,
          humidityCharacter: plant.place.humidityCharacter,
          indoorTempMinC: plant.place.indoorTempMinC,
          indoorTempMaxC: plant.place.indoorTempMaxC,
          lightType: plant.place.lightType,
        },
        weather
          ? {
              tempC: weather.tempC,
              humidityPct: weather.humidityPct,
              seasonalLowC: weather.seasonalLowC,
              seasonalHighC: weather.seasonalHighC,
            }
          : null,
      );
      return {
        plantId: plant.id,
        nickname: plant.nickname,
        speciesSlug: plant.speciesSlug,
        speciesScientificName: record.scientificName,
        speciesCommonName: primaryCommonName(record),
        ...result,
      };
    });
  }

  // Persists a planned move. Finds-or-creates the owner's destination City by coordinates
  // rounded to 4 decimals (never exact float equality), then schedules the move against it.
  async schedule(
    target: { name: string; latitude: number; longitude: number; timezone: string },
    moveOn: string,
  ): Promise<{ id: string }> {
    // Create: stamp the acting actor's owner (currentOwnerId, synchronous now).
    const ownerId = this.owner.currentOwnerId();
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

  // Applies any of ONE owner's moves whose date has arrived: target becomes primary, that owner's
  // outdoor places repoint to it. Idempotent via the `applied` flag. Owner-AGNOSTIC of the actor:
  // the ownerId is a parameter, never read from CLS — this runs in system jobs (cron/startup) that
  // have no request actor. Does NOT recompute (the all-owners caller recomputes once at the end).
  async applyDueMovesForOwner(ownerId: string, now: Date): Promise<number> {
    const primary = await this.prisma.city.findFirst({ where: { ownerId, isPrimary: true } });
    const cutoff = startOfTomorrowUtc(primary?.timezone ?? 'UTC', now);
    const due = await this.prisma.scheduledMove.findMany({
      where: { ownerId, applied: false, moveOn: { lt: cutoff } },
      orderBy: { moveOn: 'asc' },
    });

    for (const move of due) {
      await this.prisma.$transaction(async (tx) => {
        // Resolve the CURRENT primary inside the tx so a chain of due moves repoints the right places
        // each time: each move only relocates the outdoor places that were at the primary as of that move.
        const current = await tx.city.findFirst({ where: { ownerId, isPrimary: true } });
        const placeWhere = current
          ? { ownerId, indoor: false, cityId: current.id }
          : { ownerId, indoor: false }; // no-primary fallback: today's behavior (all outdoor places)
        await tx.city.updateMany({ where: { ownerId }, data: { isPrimary: false } });
        await tx.city.update({ where: { id: move.targetCityId }, data: { isPrimary: true } });
        await tx.place.updateMany({ where: placeWhere, data: { cityId: move.targetCityId } });
        await tx.scheduledMove.update({ where: { id: move.id }, data: { applied: true } });
      });
    }
    return due.length; // NOTE: no recompute here — applyAllDueMoves recomputes once at the end.
  }

  // Owner-agnostic system job (cron / startup): apply every owner's due moves, then recompute the
  // whole garden ONCE if anything applied. Never reads the CLS actor — it iterates owner.findMany().
  async applyAllDueMoves(now: Date = new Date()): Promise<number> {
    const owners = await this.prisma.owner.findMany({ select: { id: true } });
    let total = 0;
    for (const o of owners) total += await this.applyDueMovesForOwner(o.id, now);
    if (total > 0) await this.carePlan.recomputeAll();
    return total;
  }
}
