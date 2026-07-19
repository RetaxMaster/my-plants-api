import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { writeOriginAudit, type AuditContext } from '../audit/origin-audit.js';
import { emptyEffects, type WriteEffects } from '../common/write-effects.js';

/** A file already staged to the photo inbox by the caller. sortOrder is assigned by the core. */
export type ProgressPhotoInput = { inboxPath: string; originalName: string };

/** A progress entry can hold at most 8 photos (existing − removed + added), enforced under the row lock. */
export const MAX_PHOTOS_PER_ENTRY = 8;

export type CoreResult<T> = { result: T; effects: WriteEffects };

export type CreateProgressData = {
  health: string;
  /** Native Date, already resolved by the caller. NEVER an ISO string in a raw comparison. */
  occurredOn: Date;
  observations: string | null;
  sizeCm: number | null;
  /** Already validated against the ONE progress-tag catalog by the caller. */
  tags: string[];
};

async function assertOwned(tx: Prisma.TransactionClient, plantId: string, ownerId: string): Promise<void> {
  const plant = await tx.plant.findFirst({ where: { id: plantId, ownerId }, select: { id: true } });
  if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);
}

/**
 * The single implementation of "log a progress entry": the entry, its PENDING photo rows, and the paired
 * PROGRESS DONE CareEvent that carries progressEntryId. Shared by the owner endpoint and the proposal
 * applier — only the AuditContext differs.
 */
export async function createProgressCore(
  tx: Prisma.TransactionClient,
  input: {
    plantId: string;
    ownerId: string;
    data: CreateProgressData;
    photos: ProgressPhotoInput[];
    audit: AuditContext;
  },
): Promise<CoreResult<{ entryId: string }>> {
  await assertOwned(tx, input.plantId, input.ownerId);

  const entry = await tx.plantProgressEntry.create({
    data: {
      plantId: input.plantId,
      occurredOn: input.data.occurredOn,
      health: input.data.health as never,
      observations: input.data.observations,
      sizeCm: input.data.sizeCm,
      // Empty tags stay UNDEFINED (leave the column default) rather than writing an empty array.
      tags: input.data.tags.length ? (input.data.tags as unknown as Prisma.InputJsonValue) : undefined,
      photos: input.photos.length
        ? {
            create: input.photos.map((p, i) => ({
              status: 'PENDING' as const, // async path ALWAYS sets PENDING explicitly (default is READY)
              inboxPath: p.inboxPath,
              originalName: p.originalName,
              sortOrder: i,
            })),
          }
        : undefined,
    },
    select: { id: true },
  });

  await tx.careEvent.create({
    data: {
      plantId: input.plantId,
      task: 'PROGRESS',
      type: 'DONE',
      occurredOn: input.data.occurredOn,
      progressEntryId: entry.id,
    },
  });

  await writeOriginAudit(tx, {
    plantId: input.plantId,
    ownerId: input.ownerId,
    origin: input.audit.origin,
    proposalId: input.audit.proposalId,
    actorUserId: input.audit.actorUserId,
    operationType: 'progress.create',
    targetTable: 'plant_progress_entries',
    targetId: entry.id,
    payload: input.data,
  });

  const effects = emptyEffects();
  effects.recomputePlantIds.push(input.plantId);
  effects.enqueuePhotoTick = input.photos.length > 0;
  return { result: { entryId: entry.id }, effects };
}

/**
 * The field edits of a PATCH. A key's PRESENCE means "edit this field"; its absence means "leave it
 * alone". `observations` / `sizeCm` accept null to CLEAR; `health` / `occurredOn` cannot be cleared.
 * The caller has already turned its transport-level representation (an empty multipart field, an
 * explicit JSON null) into these typed values.
 */
export type UpdateProgressData = Partial<{
  health: string;
  occurredOn: Date;
  observations: string | null;
  sizeCm: number | null;
  tags: string[];
}>;

/**
 * The single implementation of "edit a progress entry": photo removals, photo additions and field edits,
 * all under the entry row lock, plus the paired CareEvent move when the date changes.
 */
export async function updateProgressCore(
  tx: Prisma.TransactionClient,
  input: {
    plantId: string;
    ownerId: string;
    entryId: string;
    data: UpdateProgressData;
    photos: ProgressPhotoInput[];
    removePhotoIds: string[];
    audit: AuditContext;
  },
): Promise<CoreResult<{ entryId: string }>> {
  // ORDER IS LOad-BEARING: the row lock comes FIRST, the ownership check second. Under InnoDB
  // REPEATABLE READ a transaction's consistent-read snapshot is established by its first NON-locking
  // SELECT. Putting the ownership read ahead of this lock would freeze the snapshot BEFORE we wait on
  // the lock, so the photo read below would see stale rows and two concurrent PATCHes could both pass
  // the ≤8 invariant. A locking read does not establish that snapshot, which is why this must lead.
  // Nothing is mutated between here and the ownership check, so checking second is safe.
  const locked = await tx.$queryRaw<{ id: string; occurred_on: Date }[]>(
    Prisma.sql`SELECT id, occurred_on FROM plant_progress_entries WHERE id = ${input.entryId} AND plant_id = ${input.plantId} FOR UPDATE`,
  );
  if (locked.length === 0) throw new NotFoundException(`Unknown progress entry: ${input.entryId}`);
  const oldOccurredOn = locked[0].occurred_on;

  await assertOwned(tx, input.plantId, input.ownerId);

  // Read the entry's photos (already implicitly protected by the entry lock for our own writes).
  const photos = await tx.plantProgressPhoto.findMany({
    where: { entryId: input.entryId },
    select: { id: true, status: true, claimToken: true, imageObjectKey: true, inboxPath: true, sortOrder: true },
  });
  const byId = new Map(photos.map((p) => [p.id, p]));

  // Validate + apply removals. A claimed row (PROCESSING/RECOVERING → claim_token set) is un-removable:
  // hard-deleting it would strand its in-flight R2 object (async spec §4.2). 409, mutate nothing.
  const toRemove = [];
  for (const rid of input.removePhotoIds) {
    const row = byId.get(rid);
    if (!row) throw new BadRequestException({ code: 'invalid_photo', message: `Not a photo of this entry: ${rid}` });
    if (row.claimToken !== null || row.status === 'PROCESSING' || row.status === 'RECOVERING') {
      throw new ConflictException({ code: 'photo_processing', message: 'That photo is still processing — try again in a moment.' });
    }
    toRemove.push(row);
  }

  // ≤8 total invariant (existing − removed + added), under the lock. Else 400.
  const remaining = photos.length - toRemove.length;
  if (remaining + input.photos.length > MAX_PHOTOS_PER_ENTRY) {
    throw new BadRequestException({ code: 'too_many_photos', message: 'A progress entry can hold at most 8 photos.' });
  }

  const effects = emptyEffects();

  // Guarded conditional delete per id: the claim_token IS NULL guard is defence-in-depth (the lock
  // already prevents a mid-delete claim). Collect the object/inbox keys FIRST for post-commit cleanup.
  for (const row of toRemove) {
    const affected = await tx.$executeRaw(
      Prisma.sql`DELETE FROM plant_progress_photos
                       WHERE id = ${row.id} AND entry_id = ${input.entryId}
                         AND status IN ('READY','FAILED','PENDING') AND claim_token IS NULL`,
    );
    if (affected !== 1) {
      // Raced into a claim despite the lock (should be impossible) — refuse rather than orphan.
      throw new ConflictException({ code: 'photo_processing', message: 'That photo is still processing — try again in a moment.' });
    }
  }
  for (const row of toRemove) {
    if (row.imageObjectKey) effects.deleteObjectKeys.push(row.imageObjectKey);
    if (row.inboxPath) effects.deleteInboxPaths.push(row.inboxPath);
  }

  // Create the new PENDING photo rows. sortOrder continues from the current max (removals leave gaps;
  // the sequence stays monotonic for display — no renumbering).
  const maxSort = photos.reduce((m, p) => Math.max(m, p.sortOrder), -1);
  for (let i = 0; i < input.photos.length; i++) {
    await tx.plantProgressPhoto.create({
      data: {
        entryId: input.entryId,
        status: 'PENDING', // async path ALWAYS sets PENDING explicitly (default is READY)
        inboxPath: input.photos[i].inboxPath,
        originalName: input.photos[i].originalName,
        sortOrder: maxSort + 1 + i,
      },
    });
  }

  // Field edits — only the PRESENT ones (clear-vs-absent). health/occurredOn cannot be cleared.
  const occurredOnPresent = 'occurredOn' in input.data;
  const sizeCmPresent = 'sizeCm' in input.data;
  const newOccurredOn = input.data.occurredOn;

  const data: Prisma.PlantProgressEntryUpdateInput = {};
  if (input.data.health !== undefined) data.health = input.data.health as never;
  if (occurredOnPresent) data.occurredOn = newOccurredOn;
  if ('observations' in input.data) data.observations = input.data.observations;
  if (sizeCmPresent) data.sizeCm = input.data.sizeCm;
  if ('tags' in input.data) {
    const tags = input.data.tags as string[];
    data.tags = tags.length
      ? (tags as unknown as Prisma.InputJsonValue)
      : (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
  }
  if (Object.keys(data).length) await tx.plantProgressEntry.update({ where: { id: input.entryId }, data });

  // Move the paired CareEvent when occurredOn changed (the event IS the "logged progress that day"
  // signal — leaving it on the old date would lie). Conditional by progressEntryId, with the bounded
  // null-FK date-fallback for a legacy event (async spec §3.3). Native Dates only — MariaDB date rule.
  if (occurredOnPresent && newOccurredOn && newOccurredOn.getTime() !== oldOccurredOn.getTime()) {
    const paired = await tx.$executeRaw(
      Prisma.sql`UPDATE care_events SET occurred_on = ${newOccurredOn} WHERE progress_entry_id = ${input.entryId}`,
    );
    if (paired === 0) {
      await tx.$executeRaw(
        Prisma.sql`UPDATE care_events SET occurred_on = ${newOccurredOn}
                         WHERE plant_id = ${input.plantId} AND task = 'PROGRESS' AND occurred_on = ${oldOccurredOn}
                           AND progress_entry_id IS NULL LIMIT 1`,
      );
    }
  }

  // No write → no audit row: the append-only log records writes that happened (same rule as plant.update).
  const wroteSomething =
    Object.keys(data).length > 0 || toRemove.length > 0 || input.photos.length > 0;
  if (wroteSomething) {
    await writeOriginAudit(tx, {
      plantId: input.plantId,
      ownerId: input.ownerId,
      origin: input.audit.origin,
      proposalId: input.audit.proposalId,
      actorUserId: input.audit.actorUserId,
      operationType: 'progress.update',
      targetTable: 'plant_progress_entries',
      targetId: input.entryId,
      payload: { ...input.data, removedPhotoIds: input.removePhotoIds, addedPhotos: input.photos.length },
    });
  }

  // Recompute on any PATCH that changes occurredOn or sizeCm (both feed care surfaces). Skip otherwise.
  if (occurredOnPresent || sizeCmPresent) effects.recomputePlantIds.push(input.plantId);
  effects.enqueuePhotoTick = input.photos.length > 0;
  return { result: { entryId: input.entryId }, effects };
}

/**
 * The single implementation of "delete a progress entry": the paired CareEvent, then the entry (photos
 * cascade), all behind locks on BOTH the entry and its photo rows.
 */
export async function deleteProgressCore(
  tx: Prisma.TransactionClient,
  input: { plantId: string; ownerId: string; entryId: string; audit: AuditContext },
): Promise<CoreResult<{ entryId: string }>> {
  // Lock FIRST, check ownership second — same REPEATABLE READ snapshot reason as updateProgressCore.
  // Lock the entry AND all its photo rows. Locking the entry alone is NOT enough: the worker's claim is
  // an UPDATE on a CHILD photo row, so only FOR UPDATE on the photo rows blocks a concurrent
  // PENDING→PROCESSING claim (async spec §4.2 / spec §2.3).
  const lockedEntry = await tx.$queryRaw<{ id: string; occurred_on: Date }[]>(
    Prisma.sql`SELECT id, occurred_on FROM plant_progress_entries WHERE id = ${input.entryId} AND plant_id = ${input.plantId} FOR UPDATE`,
  );
  if (lockedEntry.length === 0) throw new NotFoundException(`Unknown progress entry: ${input.entryId}`);
  const occurredOn = lockedEntry[0].occurred_on;

  await assertOwned(tx, input.plantId, input.ownerId);

  const photos = await tx.$queryRaw<
    { id: string; status: string; claim_token: string | null; image_object_key: string | null; inbox_path: string | null }[]
  >(
    Prisma.sql`SELECT id, status, claim_token, image_object_key, inbox_path
                   FROM plant_progress_photos WHERE entry_id = ${input.entryId} FOR UPDATE`,
  );

  // Refuse if any photo is actively claimed (PROCESSING/RECOVERING retain claim_token). A worker trying
  // to claim a PENDING photo of this entry now BLOCKS on the lock until we commit, after which its claim
  // UPDATE matches 0 rows (the photo is gone) — so the cascade can't delete a row mid-upload.
  if (photos.some((p) => p.claim_token !== null || p.status === 'PROCESSING' || p.status === 'RECOVERING')) {
    throw new ConflictException({ code: 'photo_processing', message: 'A photo is still processing — try again in a moment.' });
  }

  const effects = emptyEffects();
  for (const p of photos) {
    if (p.image_object_key) effects.deleteObjectKeys.push(p.image_object_key);
    if (p.inbox_path) effects.deleteInboxPaths.push(p.inbox_path);
  }

  // Delete the paired PROGRESS CareEvent by progressEntryId FIRST (onDelete:SetNull would otherwise null
  // the FK the delete keys on). If it matched nothing (a legacy null-FK event), the bounded date-fallback:
  // IS NULL + LIMIT 1 cannot touch a sibling entry's PAIRED event. Native Date — MariaDB date rule.
  const paired = await tx.$executeRaw(
    Prisma.sql`DELETE FROM care_events WHERE progress_entry_id = ${input.entryId}`,
  );
  if (paired === 0) {
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM care_events
                     WHERE plant_id = ${input.plantId} AND task = 'PROGRESS' AND occurred_on = ${occurredOn}
                       AND progress_entry_id IS NULL LIMIT 1`,
    );
  }

  // Delete the entry — photos cascade via the existing onDelete: Cascade.
  await tx.plantProgressEntry.delete({ where: { id: input.entryId } });

  await writeOriginAudit(tx, {
    plantId: input.plantId,
    ownerId: input.ownerId,
    origin: input.audit.origin,
    proposalId: input.audit.proposalId,
    actorUserId: input.audit.actorUserId,
    operationType: 'progress.delete',
    targetTable: 'plant_progress_entries',
    targetId: input.entryId,
    payload: { entryId: input.entryId },
  });

  effects.recomputePlantIds.push(input.plantId);
  return { result: { entryId: input.entryId }, effects };
}
