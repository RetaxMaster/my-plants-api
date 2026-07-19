import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { PhotoInboxService } from '../storage/photo-inbox.service.js';
import { PhotoWorkerService } from '../photo-worker/photo-worker.service.js';
import { startOfTodayUtc, ymdToUtcDate, ymdFromUtcDate } from '../common/time/local-date.js';
import { PROGRESS_TAGS, parseProgressTags, resolveProgressTags } from './progress-catalog.js';
import { MAX_SIZE_CM, type CreateProgressDto, type UpdateProgressDto } from './progress.dto.js';
import {
  createProgressCore,
  updateProgressCore,
  deleteProgressCore,
  type UpdateProgressData,
} from './progress.write-core.js';
import { runEffects } from '../common/write-effects.js';

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
    let effects;
    try {
      const out = await this.prisma.$transaction((tx) =>
        createProgressCore(tx, {
          plantId,
          ownerId: this.owner.currentOwnerId(),
          data: {
            health: dto.health,
            occurredOn,
            observations: dto.observations ?? null,
            sizeCm: dto.sizeCm ?? null,
            tags,
          },
          photos: staged.map((s) => ({ inboxPath: s.inboxPath, originalName: s.originalName })),
          audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
        }),
      );
      entryId = out.result.entryId;
      effects = out.effects;
    } catch (err) {
      await this.inbox.deleteMany(staged.map((s) => s.inboxPath)); // compensate staged files on any throw
      throw err;
    }

    // 3. AFTER commit: re-anchor Progress and nudge the photo worker. recomputePlant reads COMMITTED
    //    state, so it runs outside the txn, and its failure is NEVER a reason to fail the request — the
    //    entry is durable and the daily cron re-anchors. runEffects owns both, and never throws.
    await runEffects(effects, this.effectRunner());

    return this.getEntry(plantId, entryId);
  }

  async update(plantId: string, entryId: string, dto: UpdateProgressDto, files: Express.Multer.File[]) {
    // Owner-scope through the plant (404 if not owned) — the exact ownerFilter() pattern create uses.
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);

    // Parse the edit-only inputs up front (bad shape → 400 BEFORE any staging or lock).
    const removeIds = this.parseRemovePhotoIds(dto.removePhotoIds); // string[] (may be empty)
    const tagsPresent = dto.tags !== undefined;
    const tags = tagsPresent ? parseProgressTags(dto.tags) : null; // validates against the ONE catalog
    const sizeCmPresent = dto.sizeCm !== undefined;
    const sizeCm = sizeCmPresent ? this.parseSizeCm(dto.sizeCm as string) : undefined;
    const occurredOnPresent = dto.occurredOn !== undefined;
    const newOccurredOn = occurredOnPresent ? ymdToUtcDate(dto.occurredOn as string) : undefined;

    // Stage new files to the inbox FIRST (atomic temp→rename; capacity guard → 503). All-or-none: if the
    // transaction later throws (count invariant, a claimed removal), we compensate these staged files.
    const staged = files.length
      ? await this.inbox.stage(files.map((f) => ({ buffer: f.buffer, originalName: f.originalname })))
      : [];

    // The field edits, in the core's typed vocabulary. Presence means "edit"; the transport-level
    // representations ('' clears observations, '' clears sizeCm) are resolved HERE, above the core,
    // because they are multipart-form concerns the proposal applier does not share.
    const data: UpdateProgressData = {};
    if (dto.health !== undefined) data.health = dto.health;
    if (occurredOnPresent) data.occurredOn = newOccurredOn;
    if (dto.observations !== undefined) data.observations = dto.observations === '' ? null : dto.observations;
    if (sizeCmPresent) data.sizeCm = sizeCm ?? null;
    if (tagsPresent) data.tags = tags as string[];

    // Collected inside the transaction for post-commit cleanup (consistent with the rows actually deleted).
    let effects;

    try {
      effects = (
        await this.prisma.$transaction((tx) =>
          updateProgressCore(tx, {
            plantId,
            ownerId: this.owner.currentOwnerId(),
            entryId,
            data,
            photos: staged.map((s) => ({ inboxPath: s.inboxPath, originalName: s.originalName })),
            removePhotoIds: removeIds,
            audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
          }),
        )
      ).effects;
    } catch (err) {
      await this.inbox.deleteMany(staged.map((s) => s.inboxPath)); // compensate staged files on any throw
      throw err;
    }

    // AFTER commit: best-effort R2 + inbox cleanup for the removed photos (never rolls back the removal),
    // the conditional recompute, and the worker nudge for newly-added photos. runEffects never throws.
    await runEffects(effects, this.effectRunner());

    return this.getEntry(plantId, entryId);
  }

  /** Post-commit runner for this service — every effect a progress write core can report. */
  private effectRunner() {
    return {
      recomputePlant: (plantId: string) => this.carePlan.recomputePlant(plantId),
      deleteObject: (key: string) => this.images.delete(key),
      deleteInboxPaths: (paths: string[]) => this.inbox.deleteMany(paths),
      enqueuePhotoTick: () => this.worker.enqueueTick(),
      logger: this.logger,
    };
  }


  // Parse + validate the JSON-encoded removePhotoIds (spec §2.1/§2.5). Absent/'' → []. Bad JSON or a
  // non-string-array → 400. No second parser — one place, like parseProgressTags.
  // Parse the edit sizeCm (spec §2.5 / CreateProgressDto parity): present-empty '' clears (null); otherwise it
  // must be a POSITIVE integer within the DB INT range — matching create's @IsInt @IsPositive. The DTO regex
  // only guarantees digits, so '0' and an INT-overflowing value still reach here; both are a 400, never a 0
  // that would poison the height-based physical calcs or a MySQL out-of-range write (→ 500).
  private parseSizeCm(raw: string): number | null {
    if (raw === '') return null; // present-but-empty → clear
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_SIZE_CM) {
      throw new BadRequestException({ code: 'invalid_size', message: 'sizeCm must be a positive integer (cm) within range, or empty to clear.' });
    }
    return n;
  }

  private parseRemovePhotoIds(raw: string | undefined): string[] {
    if (raw === undefined || raw === '') return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new BadRequestException({ code: 'invalid_remove_photo_ids', message: 'removePhotoIds must be a JSON string array' }); }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
      throw new BadRequestException({ code: 'invalid_remove_photo_ids', message: 'removePhotoIds must be a JSON string array' });
    }
    return parsed as string[];
  }

  async retryPhoto(plantId: string, entryId: string, photoId: string) {
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);

    const flipped = await this.prisma.$transaction(async (tx) => {
      // Lock the photo row (and confirm it belongs to this entry+plant) so the re-check → flip is atomic.
      const rows = await tx.$queryRaw<{ id: string; status: string; failure_kind: string | null; inbox_path: string | null }[]>(
        Prisma.sql`SELECT ph.id, ph.status, ph.failure_kind, ph.inbox_path
                   FROM plant_progress_photos ph
                   JOIN plant_progress_entries e ON e.id = ph.entry_id
                   WHERE ph.id = ${photoId} AND ph.entry_id = ${entryId} AND e.plant_id = ${plantId}
                   FOR UPDATE`,
      );
      if (rows.length === 0) throw new NotFoundException(`Unknown photo: ${photoId}`);
      const p = rows[0];

      if (p.status === 'PENDING') return false; // ONLY an already-PENDING row is the explicit no-op (idempotent)
      // READY / PROCESSING / RECOVERING are not retryable: a client asking to retry them is a 409, not a
      // silent success (NIT 1). Only a FAILED photo can be retried.
      if (p.status !== 'FAILED') {
        throw new ConflictException({ code: 'not_retryable', message: 'That photo can’t be retried.' });
      }

      // Only a TRANSIENT failure whose staged bytes are STILL present is retryable (async spec §5.2). The
      // FOR UPDATE lock above makes this re-check atomic against the worker's inbox TTL sweep (async Task 9,
      // BLOCKER 5): that sweep only nulls inbox_path via a guarded UPDATE requiring status='FAILED', so while
      // we hold this row lock and then flip it to PENDING, the sweep cannot erase the bytes we just adopted.
      if (p.failure_kind !== 'transient' || !(await this.inbox.exists(p.inbox_path))) {
        throw new ConflictException({ code: 'not_retryable', message: 'That photo can’t be retried — remove it instead.' });
      }

      await tx.$executeRaw(
        Prisma.sql`UPDATE plant_progress_photos
                   SET status='PENDING', attempts=0, next_attempt_at=NULL,
                       failure_kind=NULL, failure_code=NULL, claim_token=NULL, updated_at=NOW(3)
                   WHERE id=${photoId} AND status='FAILED'`,
      );
      return true; // flipped FAILED→PENDING → nudge AFTER the commit
    });

    if (flipped) this.worker.enqueueTick();
    return this.getEntry(plantId, entryId);
  }

  async delete(plantId: string, entryId: string): Promise<void> {
    const { effects } = await this.prisma.$transaction((tx) =>
      deleteProgressCore(tx, {
        plantId,
        ownerId: this.owner.currentOwnerId(),
        entryId,
        audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
      }),
    );

    // AFTER commit: best-effort R2 + inbox cleanup (never blocks the delete — the row is the source of
    // truth), then the recompute (the deleted entry may have been the latest → Progress re-anchors; the
    // removed care-event may re-open the Progress task). runEffects never throws.
    await runEffects(effects, this.effectRunner());
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
    // Per-photo state (spec §5.2). imageUrl is exposed ONLY when READY (never the empty string; null otherwise).
    // retryable = a transient FAILED photo whose staged bytes still exist (the TTL sweep nulls inboxPath, at
    // which point retry is no longer possible). RECOVERING is rendered identically to PROCESSING by the web.
    const photos = entry.photos.map((p) => ({
      id: p.id,
      status: p.status,
      imageUrl: p.status === 'READY' ? p.imageUrl : null,
      sortOrder: p.sortOrder,
      originalName: p.originalName,
      failureKind: p.status === 'FAILED' ? p.failureKind : null,
      failureCode: p.status === 'FAILED' ? p.failureCode : null,
      retryable: p.status === 'FAILED' && p.failureKind === 'transient' && p.inboxPath != null,
    }));
    const NON_TERMINAL = new Set(['PENDING', 'PROCESSING', 'RECOVERING']);
    return {
      id: entry.id,
      plantId: entry.plantId,
      occurredOn: ymdFromUtcDate(entry.occurredOn),
      health: entry.health,
      observations: entry.observations,
      sizeCm: entry.sizeCm,
      tags: resolveProgressTags(tagKeys),
      photos,
      processingCount: photos.filter((p) => NON_TERMINAL.has(p.status)).length,
      failedCount: photos.filter((p) => p.status === 'FAILED').length,
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
        // photoCount counts READY photos only (spec §5.2). Load statuses to count precisely.
        include: { photos: { select: { status: true } } },
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
        photoCount: e.photos.filter((p) => p.status === 'READY').length,
        processingCount: e.photos.filter((p) => p.status !== 'READY' && p.status !== 'FAILED').length,
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
