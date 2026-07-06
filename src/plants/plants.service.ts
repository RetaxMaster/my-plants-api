import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parseSpeciesRecord, primaryCommonName, type PlantProfile } from '@retaxmaster/my-plants-species-schema';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { buildViability, type ViabilityResult } from '../engines/viability.js';
import { startOfTodayUtc, ymdFromUtcDate } from '../common/time/local-date.js';
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
    private readonly images: ImageUploadService,
  ) {}

  // Flatten the species' human-facing names onto a plant response and drop the internal R2 object key
  // (coverImageUrl is public; coverImageObjectKey is internal cleanup state). Single source for names:
  // primaryCommonName.
  private withNames<
    T extends { species: { record: unknown; scientificName: string }; coverImageObjectKey?: string | null },
  >(plant: T) {
    const { species, coverImageObjectKey: _internalKey, ...rest } = plant;
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

    // Care-basis reads (all owner-safe: the plant is already owner-scoped above). latestProgress and
    // heightCm are SEPARATE reads — heightCm filters to entries WITH a size and takes the most recent of
    // THOSE, so a later note-only entry never blanks a real height. All three share the canonical
    // occurredOn desc, createdAt desc tiebreak.
    const [profileRow, latest, latestSized, lastRepot] = await Promise.all([
      this.prisma.plantProfile.findUnique({ where: { plantId: id } }),
      this.prisma.plantProgressEntry.findFirst({
        where: { plantId: id },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, occurredOn: true, health: true, observations: true },
      }),
      this.prisma.plantProgressEntry.findFirst({
        where: { plantId: id, sizeCm: { not: null } },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        select: { sizeCm: true },
      }),
      this.prisma.careEvent.findFirst({
        where: { plantId: id, task: 'REPOT', type: 'DONE' },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        select: { occurredOn: true },
      }),
    ]);

    return {
      ...this.withNames(plant),
      profile: this.toProfileView(profileRow),
      latestProgress: latest
        ? {
            entryId: latest.id,
            occurredOn: ymdFromUtcDate(latest.occurredOn),
            health: latest.health,
            observations: latest.observations,
          }
        : null,
      derived: {
        heightCm: latestSized?.sizeCm ?? null,
        lastRepottedOn: lastRepot ? ymdFromUtcDate(lastRepot.occurredOn) : null,
      },
    };
  }

  // Read model for the plant page (spec A.5 / C.2). Phase A returns { plantId, tasks }; Phase C will
  // ADD a top-level `viability` field to this same object (pure addition — do not reshape this).
  async getCare(id: string): Promise<{
    plantId: string;
    tasks: { task: Task; nextDueOn: string; daysUntilDue: number; status: CareStatus }[];
    viability: ViabilityResult;
  }> {
    const plant = await this.prisma.plant.findFirst({
      where: { id, ...this.owner.ownerFilter() },
      include: { species: true, place: { include: { city: true } } },
    });
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

    // Boundary derives from the plant's place-city timezone (so an ADMIN viewing another owner's
    // plant gets that plant's local "today", not the admin's).
    const startOfToday = startOfTodayUtc(plant.place.city.timezone);

    const tasks = due.map((d) => {
      const { daysUntilDue, status } = careTaskStatus(d.nextDueOn, startOfToday);
      return {
        task: d.task,
        nextDueOn: ymdFromUtcDate(d.nextDueOn),
        daysUntilDue,
        status,
      };
    });

    // Viability of the plant in its CURRENT place, against its own city's weather.
    const record = parseSpeciesRecord(plant.species.record);
    const { city } = plant.place;
    const weather = await this.weather.forCity(city.id, city.latitude, city.longitude);
    const viability = buildViability(
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

    return { plantId: id, tasks, viability };
  }

  async create(dto: CreatePlantDto) {
    // Defense in depth: PROGRESS is written only by ProgressService (the DTO already rejects it in
    // lastDone). Never seed a DONE PROGRESS CareEvent from plant creation.
    if (dto.lastDone?.some((e) => e.task === 'PROGRESS')) {
      throw new BadRequestException('PROGRESS cannot be a lastDone entry');
    }

    // Create: stamp the acting actor's ownerId and validate the parent place belongs to that same
    // owner (NOT ownerFilter — even an ADMIN creates a plant under their own owner).
    const ownerId = this.owner.currentOwnerId();
    const place = await this.prisma.place.findFirst({ where: { id: dto.placeId, ownerId } });
    if (!place) throw new BadRequestException(`Unknown place: ${dto.placeId}`);
    const species = await this.prisma.species.findUnique({ where: { slug: dto.speciesSlug } });
    if (!species) throw new BadRequestException(`Unknown species: ${dto.speciesSlug}`);

    const created = await this.prisma.plant.create({
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
    // Strip the internal R2 object key from the created view (coverImageUrl is public; the object key
    // is internal cleanup state and must not leak). The web's createPlant only reads `.id`.
    const { coverImageObjectKey: _omit, ...view } = created;
    return view;
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

  // Map a plant_profiles row (or its absence) to the 9-field, all-nullable Spec-1 profile shape. The
  // enum columns store validated slugs, so the string->enum-union cast is sound.
  private toProfileView(row: {
    windowDistance: string | null;
    growLight: boolean | null;
    potType: string | null;
    potSizeCm: number | null;
    hasDrainage: boolean | null;
    soilMix: string | null;
    growthHabit: string | null;
    ageMonths: number | null;
    nearHeater: boolean | null;
  } | null): PlantProfile {
    return {
      windowDistance: (row?.windowDistance ?? null) as PlantProfile['windowDistance'],
      growLight: row?.growLight ?? null,
      potType: (row?.potType ?? null) as PlantProfile['potType'],
      potSizeCm: row?.potSizeCm ?? null,
      hasDrainage: row?.hasDrainage ?? null,
      soilMix: (row?.soilMix ?? null) as PlantProfile['soilMix'],
      growthHabit: (row?.growthHabit ?? null) as PlantProfile['growthHabit'],
      ageMonths: row?.ageMonths ?? null,
      nearHeater: row?.nearHeater ?? null,
    };
  }

  // GET /plants/:id/profile — owner-scoped; returns the all-null shape when no row exists yet (never
  // 404 for a plant the owner owns).
  async getProfile(id: string): Promise<PlantProfile> {
    const plant = await this.prisma.plant.findFirst({
      where: { id, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    const row = await this.prisma.plantProfile.findUnique({ where: { plantId: id } });
    return this.toProfileView(row);
  }

  // GET /plants/:id/photos — every PlantProgressPhoto for the plant, flattened newest-first. A new READ
  // over existing rows (no new photo storage). Entries are ordered occurredOn desc, createdAt desc; the
  // photos within an entry keep their sortOrder asc. Each item carries the owning entryId so the web can
  // open that progress entry.
  async getPhotos(id: string): Promise<
    { id: string; imageUrl: string; entryId: string; occurredOn: string; sortOrder: number }[]
  > {
    const plant = await this.prisma.plant.findFirst({
      where: { id, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);

    const entries = await this.prisma.plantProgressEntry.findMany({
      where: { plantId: id },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        occurredOn: true,
        photos: { orderBy: { sortOrder: 'asc' }, select: { id: true, imageUrl: true, sortOrder: true } },
      },
    });

    return entries.flatMap((entry) =>
      entry.photos.map((photo) => ({
        id: photo.id,
        imageUrl: photo.imageUrl,
        entryId: entry.id,
        occurredOn: ymdFromUtcDate(entry.occurredOn),
        sortOrder: photo.sortOrder,
      })),
    );
  }

  // PATCH /plants/:id/profile — partial merge (absent key = unchanged, explicit null = clear). The body
  // is ALREADY validated by ZodValidationPipe(plantProfileUpdateSchema) at the route, so `patch` here
  // is a trusted, partial, in-vocabulary object.
  async updateProfile(id: string, patch: Partial<PlantProfile>): Promise<PlantProfile> {
    const plant = await this.prisma.plant.findFirst({
      where: { id, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    const row = await this.prisma.plantProfile.upsert({
      where: { plantId: id },
      create: { plantId: id, ...patch },
      update: { ...patch },
    });
    return this.toProfileView(row);
  }

  // PUT /plants/:id/cover-photo — upload-then-DB, orphan-safe (mirrors blog.service setCover). On a DB
  // failure the just-uploaded object is deleted; on success the PREVIOUS object is best-effort deleted.
  // Setting a cover writes NO progress entry (this method never touches PlantProgressEntry).
  async setCover(id: string, file: Express.Multer.File | undefined) {
    const plant = await this.prisma.plant.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    if (!file) throw new BadRequestException('a photo file (field "photo") is required');

    const stored = await this.images.upload({ buffer: file.buffer, keyPrefix: `plants/${id}/cover` });
    try {
      await this.prisma.plant.update({
        where: { id },
        data: { coverImageUrl: stored.imageUrl, coverImageObjectKey: stored.imageObjectKey },
      });
    } catch (err) {
      await this.images.delete(stored.imageObjectKey); // DB write failed -> don't orphan the object
      throw err;
    }
    await this.images.delete(plant.coverImageObjectKey); // best-effort: remove the replaced object
    return this.get(id);
  }

  // DELETE /plants/:id/cover-photo — clears both columns + best-effort deletes the object. Idempotent.
  async deleteCover(id: string) {
    const plant = await this.prisma.plant.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    if (plant.coverImageUrl || plant.coverImageObjectKey) {
      await this.prisma.plant.update({
        where: { id },
        data: { coverImageUrl: null, coverImageObjectKey: null },
      });
      await this.images.delete(plant.coverImageObjectKey);
    }
    return this.get(id);
  }
}
