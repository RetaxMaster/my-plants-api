import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parseSpeciesRecord, primaryCommonName } from '@retaxmaster/my-plants-species-schema';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { buildViability, type ViabilityResult } from '../engines/viability.js';
import { startOfTodayUtc } from '../common/time/local-date.js';
import { careTaskStatus, type CareStatus } from './plant-care.js';
import type { Task } from '@prisma/client';
import type { CreatePlantDto } from './create-plant.dto.js';
import type { UpdatePlantDto } from './update-plant.dto.js';

@Injectable()
export class PlantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly carePlan: CarePlanService,
    private readonly weather: WeatherService,
  ) {}

  // Flatten the species' human-facing names onto a plant response (single source: primaryCommonName).
  private withNames<T extends { species: { record: unknown; scientificName: string } }>(plant: T) {
    const { species, ...rest } = plant;
    return {
      ...rest,
      speciesScientificName: species.scientificName,
      speciesCommonName: primaryCommonName(parseSpeciesRecord(species.record)),
    };
  }

  async list() {
    const plants = await this.prisma.plant.findMany({
      where: { ...this.owner.ownerFilter() },
      include: { species: true },
    });
    return plants.map((p) => this.withNames(p));
  }

  async get(id: string) {
    const plant = await this.prisma.plant.findFirst({
      where: { id, ...this.owner.ownerFilter() },
      include: { species: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    return this.withNames(plant);
  }

  // Read model for the plant page (spec A.5 / C.2). Phase A returns { plantId, tasks }; Phase C will
  // ADD a top-level `viability` field to this same object (pure addition — do not reshape this).
  async getCare(id: string): Promise<{
    plantId: string;
    tasks: { task: Task; nextDueOn: string; daysUntilDue: number; status: CareStatus }[];
    viability: ViabilityResult;
  }> {
    const plant = await this.prisma.plant.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);

    // If the cache is empty (e.g. plant created before any recompute), recompute on demand so the
    // page is never spuriously empty.
    let due = await this.prisma.dueCache.findMany({
      where: { plantId: id },
      select: { task: true, nextDueOn: true },
      orderBy: { nextDueOn: 'asc' },
    });
    if (due.length === 0) {
      await this.carePlan.recomputePlant(id);
      due = await this.prisma.dueCache.findMany({
        where: { plantId: id },
        select: { task: true, nextDueOn: true },
        orderBy: { nextDueOn: 'asc' },
      });
    }

    // Boundary uses the PLANT's owner primary-city timezone (so an ADMIN viewing another owner's
    // plant gets that owner's local "today", not the admin's).
    const primary = await this.prisma.city.findFirst({ where: { ownerId: plant.ownerId, isPrimary: true } });
    const startOfToday = startOfTodayUtc(primary?.timezone ?? 'UTC');

    const tasks = due.map((d) => {
      const { daysUntilDue, status } = careTaskStatus(d.nextDueOn, startOfToday);
      return {
        task: d.task,
        nextDueOn: formatYmd(d.nextDueOn),
        daysUntilDue,
        status,
      };
    });

    // Viability of the plant in its CURRENT place, against its own city's weather.
    const full = await this.prisma.plant.findUniqueOrThrow({
      where: { id },
      include: { species: true, place: { include: { city: true } } },
    });
    const record = parseSpeciesRecord(full.species.record);
    const { city } = full.place;
    const weather = await this.weather.forCity(city.id, city.latitude, city.longitude);
    const viability = buildViability(
      record,
      {
        indoor: full.place.indoor,
        climateControlled: full.place.climateControlled,
        humidityCharacter: full.place.humidityCharacter,
        indoorTempMinC: full.place.indoorTempMinC,
        indoorTempMaxC: full.place.indoorTempMaxC,
        lightType: full.place.lightType,
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

    return { plantId: id, tasks, viability };
  }

  async create(dto: CreatePlantDto) {
    // Create: stamp the acting actor's ownerId and validate the parent place belongs to that same
    // owner (NOT ownerFilter — even an ADMIN creates a plant under their own owner).
    const ownerId = this.owner.currentOwnerId();
    const place = await this.prisma.place.findFirst({ where: { id: dto.placeId, ownerId } });
    if (!place) throw new BadRequestException(`Unknown place: ${dto.placeId}`);
    const species = await this.prisma.species.findUnique({ where: { slug: dto.speciesSlug } });
    if (!species) throw new BadRequestException(`Unknown species: ${dto.speciesSlug}`);

    return this.prisma.plant.create({
      data: {
        ownerId,
        placeId: dto.placeId,
        speciesSlug: dto.speciesSlug,
        nickname: dto.nickname,
        acquiredOn: new Date(dto.acquiredOn),
        // Optional per-task last-done dates become DONE events = the first-due anchors.
        events: dto.lastDone?.length
          ? { create: dto.lastDone.map((e) => ({ task: e.task, type: 'DONE' as const, occurredOn: new Date(e.doneOn) })) }
          : undefined,
      },
    });
  }

  async update(id: string, dto: UpdatePlantDto) {
    const plant = await this.prisma.plant.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);

    const data: { nickname?: string | null; placeId?: string } = {};
    let recompute = false;

    if (dto.nickname !== undefined) data.nickname = dto.nickname.trim() || null;

    if (dto.placeId !== undefined && dto.placeId !== plant.placeId) {
      const place = await this.prisma.place.findFirst({ where: { id: dto.placeId, ownerId: plant.ownerId } });
      if (!place) throw new BadRequestException(`Unknown place: ${dto.placeId}`);
      data.placeId = dto.placeId;
      recompute = true;
    }

    if (Object.keys(data).length > 0) await this.prisma.plant.update({ where: { id }, data });
    if (recompute) await this.carePlan.recomputePlant(id);
    return this.get(id);
  }

  async viabilityPreview(id: string, placeId: string) {
    const plant = await this.prisma.plant.findFirst({ where: { id, ...this.owner.ownerFilter() }, include: { species: true } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    const place = await this.prisma.place.findFirst({ where: { id: placeId, ownerId: plant.ownerId }, include: { city: true } });
    if (!place) throw new BadRequestException(`Unknown place: ${placeId}`);
    const record = parseSpeciesRecord(plant.species.record);
    const weather = await this.weather.forCity(place.city.id, place.city.latitude, place.city.longitude);
    return buildViability(
      record,
      {
        indoor: place.indoor, climateControlled: place.climateControlled, humidityCharacter: place.humidityCharacter,
        indoorTempMinC: place.indoorTempMinC, indoorTempMaxC: place.indoorTempMaxC, lightType: place.lightType,
      },
      weather ? { tempC: weather.tempC, humidityPct: weather.humidityPct, seasonalLowC: weather.seasonalLowC, seasonalHighC: weather.seasonalHighC } : null,
    );
  }
}

// Render a @db.Date (UTC-midnight) as YYYY-MM-DD from its UTC calendar parts.
function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
