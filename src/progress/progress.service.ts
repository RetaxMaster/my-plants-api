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
import type { CreateProgressDto, UpdateProgressDto } from './progress.dto.js';

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

    // Collected inside the transaction for post-commit cleanup (consistent with the rows actually deleted).
    let removedObjects: { imageObjectKey: string | null; inboxPath: string | null }[] = [];
    let recompute = false;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Lock the entry row so a second PATCH serialises behind us (count + sortOrder are read-modify-write).
        const locked = await tx.$queryRaw<{ id: string; occurred_on: Date }[]>(
          Prisma.sql`SELECT id, occurred_on FROM plant_progress_entries WHERE id = ${entryId} AND plant_id = ${plantId} FOR UPDATE`,
        );
        if (locked.length === 0) throw new NotFoundException(`Unknown progress entry: ${entryId}`);
        const oldOccurredOn = locked[0].occurred_on;

        // Read the entry's photos (already implicitly protected by the entry lock for our own writes).
        const photos = await tx.plantProgressPhoto.findMany({
          where: { entryId },
          select: { id: true, status: true, claimToken: true, imageObjectKey: true, inboxPath: true, sortOrder: true },
        });
        const byId = new Map(photos.map((p) => [p.id, p]));

        // Validate + apply removals. A claimed row (PROCESSING/RECOVERING → claim_token set) is un-removable:
        // hard-deleting it would strand its in-flight R2 object (async spec §4.2). 409, mutate nothing.
        const toRemove = [];
        for (const rid of removeIds) {
          const row = byId.get(rid);
          if (!row) throw new BadRequestException({ code: 'invalid_photo', message: `Not a photo of this entry: ${rid}` });
          if (row.claimToken !== null || row.status === 'PROCESSING' || row.status === 'RECOVERING') {
            throw new ConflictException({ code: 'photo_processing', message: 'That photo is still processing — try again in a moment.' });
          }
          toRemove.push(row);
        }

        // ≤8 total invariant (existing − removed + added), under the lock. Else 400.
        const remaining = photos.length - toRemove.length;
        if (remaining + staged.length > 8) {
          throw new BadRequestException({ code: 'too_many_photos', message: 'A progress entry can hold at most 8 photos.' });
        }

        // Guarded conditional delete per id: the claim_token IS NULL guard is defence-in-depth (the lock
        // already prevents a mid-delete claim). Collect the object/inbox keys FIRST for post-commit cleanup.
        for (const row of toRemove) {
          const affected = await tx.$executeRaw(
            Prisma.sql`DELETE FROM plant_progress_photos
                       WHERE id = ${row.id} AND entry_id = ${entryId}
                         AND status IN ('READY','FAILED','PENDING') AND claim_token IS NULL`,
          );
          if (affected !== 1) {
            // Raced into a claim despite the lock (should be impossible) — refuse rather than orphan.
            throw new ConflictException({ code: 'photo_processing', message: 'That photo is still processing — try again in a moment.' });
          }
        }
        removedObjects = toRemove.map((r) => ({ imageObjectKey: r.imageObjectKey, inboxPath: r.inboxPath }));

        // Create the new PENDING photo rows. sortOrder continues from the current max (removals leave gaps;
        // the sequence stays monotonic for display — no renumbering).
        const maxSort = photos.reduce((m, p) => Math.max(m, p.sortOrder), -1);
        for (let i = 0; i < staged.length; i++) {
          await tx.plantProgressPhoto.create({
            data: {
              entryId,
              status: 'PENDING', // async path ALWAYS sets PENDING explicitly (default is READY)
              inboxPath: staged[i].inboxPath,
              originalName: staged[i].originalName,
              sortOrder: maxSort + 1 + i,
            },
          });
        }

        // Field edits — only the PRESENT ones (clear-vs-absent). health/occurredOn cannot be cleared.
        const data: Prisma.PlantProgressEntryUpdateInput = {};
        if (dto.health !== undefined) data.health = dto.health;
        if (occurredOnPresent) data.occurredOn = newOccurredOn;
        if (dto.observations !== undefined) data.observations = dto.observations === '' ? null : dto.observations;
        if (sizeCmPresent) data.sizeCm = sizeCm;
        if (tagsPresent) data.tags = (tags as string[]).length ? (tags as unknown as Prisma.InputJsonValue) : (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
        if (Object.keys(data).length) await tx.plantProgressEntry.update({ where: { id: entryId }, data });

        // Move the paired CareEvent when occurredOn changed (the event IS the "logged progress that day"
        // signal — leaving it on the old date would lie). Conditional by progressEntryId, with the bounded
        // null-FK date-fallback for a legacy event (async spec §3.3). Native Dates only — MariaDB date rule.
        if (occurredOnPresent && newOccurredOn && newOccurredOn.getTime() !== oldOccurredOn.getTime()) {
          const paired = await tx.$executeRaw(
            Prisma.sql`UPDATE care_events SET occurred_on = ${newOccurredOn} WHERE progress_entry_id = ${entryId}`,
          );
          if (paired === 0) {
            await tx.$executeRaw(
              Prisma.sql`UPDATE care_events SET occurred_on = ${newOccurredOn}
                         WHERE plant_id = ${plantId} AND task = 'PROGRESS' AND occurred_on = ${oldOccurredOn}
                           AND progress_entry_id IS NULL LIMIT 1`,
            );
          }
        }

        // Recompute on any PATCH that changes occurredOn or sizeCm (both feed care surfaces). Skip otherwise.
        recompute = occurredOnPresent || sizeCmPresent;
      });
    } catch (err) {
      await this.inbox.deleteMany(staged.map((s) => s.inboxPath)); // compensate staged files on any throw
      throw err;
    }

    // AFTER commit: best-effort R2 + inbox cleanup for the removed photos (never rolls back the removal).
    await Promise.all(removedObjects.filter((o) => o.imageObjectKey).map((o) => this.images.delete(o.imageObjectKey!)));
    await this.inbox.deleteMany(removedObjects.map((o) => o.inboxPath));

    if (recompute) {
      try {
        await this.carePlan.recomputePlant(plantId);
      } catch (err) {
        this.logger.warn(`PATCH ${entryId}: recompute failed for plant ${plantId}; daily cron will re-anchor: ${(err as Error).message}`);
      }
    }
    if (staged.length) this.worker.enqueueTick(); // process the newly-added photos within a moment

    return this.getEntry(plantId, entryId);
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
    if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) {
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
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);

    let objects: { imageObjectKey: string | null; inboxPath: string | null }[] = [];

    await this.prisma.$transaction(async (tx) => {
      // Lock the entry AND all its photo rows. Locking the entry alone is NOT enough: the worker's claim is
      // an UPDATE on a CHILD photo row, so only FOR UPDATE on the photo rows blocks a concurrent
      // PENDING→PROCESSING claim (async spec §4.2 / spec §2.3).
      const lockedEntry = await tx.$queryRaw<{ id: string; occurred_on: Date }[]>(
        Prisma.sql`SELECT id, occurred_on FROM plant_progress_entries WHERE id = ${entryId} AND plant_id = ${plantId} FOR UPDATE`,
      );
      if (lockedEntry.length === 0) throw new NotFoundException(`Unknown progress entry: ${entryId}`);
      const occurredOn = lockedEntry[0].occurred_on;

      const photos = await tx.$queryRaw<{ id: string; status: string; claim_token: string | null; image_object_key: string | null; inbox_path: string | null }[]>(
        Prisma.sql`SELECT id, status, claim_token, image_object_key, inbox_path
                   FROM plant_progress_photos WHERE entry_id = ${entryId} FOR UPDATE`,
      );

      // Refuse if any photo is actively claimed (PROCESSING/RECOVERING retain claim_token). A worker trying
      // to claim a PENDING photo of this entry now BLOCKS on the lock until we commit, after which its claim
      // UPDATE matches 0 rows (the photo is gone) — so the cascade can't delete a row mid-upload.
      if (photos.some((p) => p.claim_token !== null || p.status === 'PROCESSING' || p.status === 'RECOVERING')) {
        throw new ConflictException({ code: 'photo_processing', message: 'A photo is still processing — try again in a moment.' });
      }
      objects = photos.map((p) => ({ imageObjectKey: p.image_object_key, inboxPath: p.inbox_path }));

      // Delete the paired PROGRESS CareEvent by progressEntryId FIRST (onDelete:SetNull would otherwise null
      // the FK the delete keys on). If it matched nothing (a legacy null-FK event), the bounded date-fallback:
      // IS NULL + LIMIT 1 cannot touch a sibling entry's PAIRED event. Native Date — MariaDB date rule.
      const paired = await tx.$executeRaw(
        Prisma.sql`DELETE FROM care_events WHERE progress_entry_id = ${entryId}`,
      );
      if (paired === 0) {
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM care_events
                     WHERE plant_id = ${plantId} AND task = 'PROGRESS' AND occurred_on = ${occurredOn}
                       AND progress_entry_id IS NULL LIMIT 1`,
        );
      }

      // Delete the entry — photos cascade via the existing onDelete: Cascade.
      await tx.plantProgressEntry.delete({ where: { id: entryId } });
    });

    // AFTER commit: best-effort R2 + inbox cleanup (never blocks the delete — the row is the source of truth).
    await Promise.all(objects.filter((o) => o.imageObjectKey).map((o) => this.images.delete(o.imageObjectKey!)));
    await this.inbox.deleteMany(objects.map((o) => o.inboxPath));

    // Recompute: the deleted entry may have been the latest → Progress re-anchors; the removed care-event may
    // re-open the Progress task. Outside-txn + logged-failure pattern.
    try {
      await this.carePlan.recomputePlant(plantId);
    } catch (err) {
      this.logger.warn(`DELETE ${entryId}: recompute failed for plant ${plantId}; daily cron will re-anchor: ${(err as Error).message}`);
    }
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
