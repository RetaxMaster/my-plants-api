import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { startOfTodayUtc, ymdToUtcDate, ymdFromUtcDate } from '../common/time/local-date.js';
import { PROGRESS_TAGS, parseProgressTags, resolveProgressTags } from './progress-catalog.js';
import type { CreateProgressDto } from './progress.dto.js';

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly images: ImageUploadService,
    private readonly carePlan: CarePlanService,
  ) {}

  catalog() {
    return PROGRESS_TAGS;
  }

  async create(plantId: string, dto: CreateProgressDto, files: Express.Multer.File[]) {
    // 1. Load + owner-scope the plant (404 if not owned). Need the place-city tz for the default date.
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      include: { place: { include: { city: true } } },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);

    // Validate tags against the catalog BEFORE any upload (a bad tag must never leave orphan objects).
    const tags = parseProgressTags(dto.tags);

    // occurredOn: explicit YYYY-MM-DD, else today in the plant's place-city timezone. Native UTC Date
    // (@db.Date), never an ISO string — MariaDB date rule.
    const occurredOn = dto.occurredOn ? ymdToUtcDate(dto.occurredOn) : startOfTodayUtc(plant.place.city.timezone);

    // 2. Upload ALL photos first. On any failure, delete what we already uploaded and abort BEFORE
    //    any DB write (no orphans, no rows). Upload errors are ImageUploadError → 422/503 via the
    //    storage exception filter.
    const uploaded: { imageUrl: string; imageObjectKey: string }[] = [];
    try {
      for (const f of files) {
        uploaded.push(await this.images.upload({ buffer: f.buffer, keyPrefix: `plants/${plantId}/progress` }));
      }
    } catch (err) {
      await this.cleanup(uploaded);
      throw err;
    }

    // 3. One transaction: entry + photo rows + the DONE PROGRESS CareEvent. All-or-nothing. On a
    //    throw, the rows never existed → delete the uploaded objects (they reference nothing).
    let entryId: string;
    try {
      entryId = await this.prisma.$transaction(async (tx) => {
        const entry = await tx.plantProgressEntry.create({
          data: {
            plantId,
            occurredOn,
            health: dto.health,
            observations: dto.observations ?? null,
            sizeCm: dto.sizeCm ?? null,
            tags: tags.length ? (tags as unknown as Prisma.InputJsonValue) : undefined,
            photos: uploaded.length
              ? { create: uploaded.map((u, i) => ({ imageUrl: u.imageUrl, imageObjectKey: u.imageObjectKey, sortOrder: i })) }
              : undefined,
          },
          select: { id: true },
        });
        await tx.careEvent.create({ data: { plantId, task: 'PROGRESS', type: 'DONE', occurredOn } });
        return entry.id;
      });
    } catch (err) {
      await this.cleanup(uploaded);
      throw err;
    }

    // 4. AFTER commit: re-anchor Progress to next Monday. recomputePlant uses the root client and reads
    //    COMMITTED state, so it must run outside the transaction (inside it would not see the event).
    // 5. Its failure is NEVER a reason to delete photos — the entry is already durable. The daily 05:00
    //    cron (and on-boot recompute) re-anchor Progress on the next run. (Lazy per-plant read won't:
    //    it only recomputes when the due cache is empty, and the stale Monday row is still present.)
    try {
      await this.carePlan.recomputePlant(plantId);
    } catch (err) {
      this.logger.warn(`Progress saved (${entryId}) but recompute failed for plant ${plantId}; daily cron will re-anchor: ${(err as Error).message}`);
    }

    return this.getEntry(plantId, entryId);
  }

  async getEntry(plantId: string, entryId: string) {
    // Owner-scope through the plant, then load the entry constrained to that plant.
    const owned = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException(`Unknown plant: ${plantId}`);

    const entry = await this.prisma.plantProgressEntry.findFirst({
      where: { id: entryId, plantId },
      include: { photos: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!entry) throw new NotFoundException(`Unknown progress entry: ${entryId}`);

    const tagKeys = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    return {
      id: entry.id,
      plantId: entry.plantId,
      occurredOn: ymdFromUtcDate(entry.occurredOn),
      health: entry.health,
      observations: entry.observations,
      sizeCm: entry.sizeCm,
      tags: resolveProgressTags(tagKeys),
      photos: entry.photos.map((p) => ({ id: p.id, imageUrl: p.imageUrl, sortOrder: p.sortOrder })),
    };
  }

  // Best-effort R2 cleanup for a failed create (delete never throws into the caller — spec 1).
  private async cleanup(uploaded: { imageObjectKey: string }[]): Promise<void> {
    await Promise.all(uploaded.map((u) => this.images.delete(u.imageObjectKey)));
  }
}
