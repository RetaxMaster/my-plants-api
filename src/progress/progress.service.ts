import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { PhotoInboxService } from '../storage/photo-inbox.service.js';
import { PhotoWorkerService } from '../photo-worker/photo-worker.service.js';
import { startOfTodayUtc, ymdToUtcDate, ymdFromUtcDate } from '../common/time/local-date.js';
import { PROGRESS_TAGS, parseProgressTags, resolveProgressTags } from './progress-catalog.js';
import type { CreateProgressDto } from './progress.dto.js';

// The six species-scheduled care tasks. PROGRESS is intentionally excluded — it is the richer
// 'progress' item, not an action note. Single source for the history action allowlist.
const CARE_ACTION_TASKS = ['WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST'] as const;
type CareActionTask = (typeof CARE_ACTION_TASKS)[number];

// Cap the merged feed (documented, never a silent truncation). Latest 100 by date.
const HISTORY_CAP = 100;

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly images: ImageUploadService,
    private readonly carePlan: CarePlanService,
    private readonly inbox: PhotoInboxService,
    private readonly worker: PhotoWorkerService,
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

    // Validate tags against the catalog BEFORE any staging (a bad tag must never leave orphan files).
    const tags = parseProgressTags(dto.tags);

    // occurredOn: explicit YYYY-MM-DD, else today in the plant's place-city timezone. Native UTC Date
    // (@db.Date), never an ISO string — MariaDB date rule.
    const occurredOn = dto.occurredOn ? ymdToUtcDate(dto.occurredOn) : startOfTodayUtc(plant.place.city.timezone);

    // 1. Stage every file to the inbox FIRST (atomic temp→rename; capacity guard). All-or-none: a
    //    photo_storage_busy (503) here rejects the whole request before anything is persisted (spec §3.2/§5.1).
    //    No R2 upload in the request anymore — the async worker decodes/uploads each photo one at a time.
    const staged = files.length
      ? await this.inbox.stage(files.map((f) => ({ buffer: f.buffer, originalName: f.originalname })))
      : [];

    // 2. ONE transaction: entry + PENDING photo rows + the PROGRESS DONE CareEvent (carrying progressEntryId).
    //    On a throw, delete the staged files (compensation) and rethrow.
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
            photos: staged.length
              ? { create: staged.map((s, i) => ({
                  status: 'PENDING' as const, // async path ALWAYS sets PENDING explicitly (default is READY)
                  inboxPath: s.inboxPath,
                  originalName: s.originalName,
                  sortOrder: i,
                })) }
              : undefined,
          },
          select: { id: true },
        });
        await tx.careEvent.create({
          data: { plantId, task: 'PROGRESS', type: 'DONE', occurredOn, progressEntryId: entry.id },
        });
        return entry.id;
      });
    } catch (err) {
      await this.inbox.deleteMany(staged.map((s) => s.inboxPath)); // compensate staged files on any throw
      throw err;
    }

    // 3. AFTER commit: re-anchor Progress. recomputePlant reads COMMITTED state, so it runs outside the txn.
    //    Its failure is NEVER a reason to fail the request — the entry is durable; the daily cron re-anchors.
    try {
      await this.carePlan.recomputePlant(plantId);
    } catch (err) {
      this.logger.warn(`Progress saved (${entryId}) but recompute failed for plant ${plantId}; daily cron will re-anchor: ${(err as Error).message}`);
    }

    // 4. Nudge the worker so the photos process within a moment (not on the next 30 s sweep).
    this.worker.enqueueTick();

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

  // A single merged, reverse-chronological feed of two kinds: progress entries (clickable → detail)
  // and completed care actions (read-only info notes). Owner-scoped. The web renders relative phrasing
  // ("Watered 3 days ago") from occurredOn + today.
  async history(plantId: string) {
    const owned = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException(`Unknown plant: ${plantId}`);

    const [entries, events] = await Promise.all([
      this.prisma.plantProgressEntry.findMany({
        where: { plantId },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        take: HISTORY_CAP,
        include: { _count: { select: { photos: true } } },
      }),
      this.prisma.careEvent.findMany({
        where: { plantId, type: 'DONE', task: { in: [...CARE_ACTION_TASKS] } },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        take: HISTORY_CAP,
      }),
    ]);

    const items = [
      ...entries.map((e) => ({
        kind: 'progress' as const,
        entryId: e.id,
        occurredOn: ymdFromUtcDate(e.occurredOn),
        health: e.health,
        photoCount: e._count.photos,
        tagCount: Array.isArray(e.tags) ? e.tags.length : 0,
        _sortDate: e.occurredOn.getTime(),
        _sortCreated: e.createdAt.getTime(),
      })),
      ...events.map((ev) => ({
        kind: 'action' as const,
        task: ev.task as CareActionTask,
        type: 'DONE' as const,
        occurredOn: ymdFromUtcDate(ev.occurredOn),
        _sortDate: ev.occurredOn.getTime(),
        _sortCreated: ev.createdAt.getTime(),
      })),
    ];

    // occurredOn desc, then createdAt desc as a stable tiebreak.
    items.sort((a, b) => b._sortDate - a._sortDate || b._sortCreated - a._sortCreated);

    // Strip the private sort keys; cap the merged length.
    return items.slice(0, HISTORY_CAP).map(({ _sortDate, _sortCreated, ...item }) => item);
  }
}
