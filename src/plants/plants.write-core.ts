import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PlantProfile } from '@retaxmaster/my-plants-species-schema';
import { writeOriginAudit, type AuditContext } from '../audit/origin-audit.js';
import { emptyEffects, type WriteEffects } from '../common/write-effects.js';

export type CoreResult<T> = { result: T; effects: WriteEffects };

/**
 * `nickname` accepts an explicit null so the doctor path can CLEAR it. The owner's UpdatePlantDto
 * rejects null at the route (ValidateIf + IsString), so this widening is unreachable from the owner
 * endpoint — it does not loosen the owner contract.
 */
export type UpdatePlantPatch = { nickname?: string | null; placeId?: string };

/**
 * The single implementation of "update a plant's nickname / place".
 * Called by PlantsService.update (owner path) and by the proposal applier — same code, only the
 * AuditContext differs. Performs ONLY DB writes; the caller owns the transaction and the effects.
 */
export async function updatePlantCore(
  tx: Prisma.TransactionClient,
  input: { plantId: string; ownerId: string; patch: UpdatePlantPatch; audit: AuditContext },
): Promise<CoreResult<{ id: string }>> {
  const plant = await tx.plant.findFirst({ where: { id: input.plantId, ownerId: input.ownerId } });
  if (!plant) throw new NotFoundException(`Unknown plant: ${input.plantId}`);

  const data: { nickname?: string | null; placeId?: string } = {};
  const effects = emptyEffects();

  if (input.patch.nickname !== undefined) {
    const trimmed = typeof input.patch.nickname === 'string' ? input.patch.nickname.trim() : null;
    data.nickname = trimmed === '' ? null : trimmed;
  }

  // Only a REAL move validates and recomputes. Re-sending the current place is a no-op, exactly as
  // before this refactor: recomputing a care plan that cannot have changed churns the schedule for
  // nothing, and it would let an idempotent re-apply look like a real change.
  if (input.patch.placeId !== undefined && input.patch.placeId !== plant.placeId) {
    const place = await tx.place.findFirst({ where: { id: input.patch.placeId, ownerId: input.ownerId } });
    if (!place) throw new BadRequestException(`Unknown place: ${input.patch.placeId}`);
    data.placeId = input.patch.placeId;
    effects.recomputePlantIds.push(input.plantId);
  }

  // Nothing to write → no write, and therefore NO audit row. The audit log is append-only and records
  // writes that happened; a row for a write that did not happen is a lie in a table people trust.
  if (Object.keys(data).length === 0) return { result: { id: input.plantId }, effects };

  await tx.plant.update({ where: { id: input.plantId }, data });
  await writeOriginAudit(tx, {
    plantId: input.plantId,
    ownerId: input.ownerId,
    origin: input.audit.origin,
    proposalId: input.audit.proposalId,
    actorUserId: input.audit.actorUserId,
    operationType: 'plant.update',
    targetTable: 'plants',
    targetId: input.plantId,
    payload: data,
  });

  return { result: { id: input.plantId }, effects };
}

/**
 * The single implementation of "patch the 9 profile fields". Partial merge: an absent key is unchanged,
 * an explicit null clears. The profile feeds the watering center, so any write moves the schedule.
 */
export async function updateProfileCore(
  tx: Prisma.TransactionClient,
  input: { plantId: string; ownerId: string; patch: Partial<PlantProfile>; audit: AuditContext },
): Promise<CoreResult<Record<string, unknown>>> {
  const plant = await tx.plant.findFirst({
    where: { id: input.plantId, ownerId: input.ownerId },
    select: { id: true },
  });
  if (!plant) throw new NotFoundException(`Unknown plant: ${input.plantId}`);

  const row = await tx.plantProfile.upsert({
    where: { plantId: input.plantId },
    create: { plantId: input.plantId, ...input.patch },
    update: { ...input.patch },
  });
  await writeOriginAudit(tx, {
    plantId: input.plantId,
    ownerId: input.ownerId,
    origin: input.audit.origin,
    proposalId: input.audit.proposalId,
    actorUserId: input.audit.actorUserId,
    operationType: 'profile.update',
    targetTable: 'plant_profiles',
    targetId: input.plantId,
    payload: input.patch,
  });

  const effects = emptyEffects();
  effects.recomputePlantIds.push(input.plantId);
  return { result: row as unknown as Record<string, unknown>, effects };
}
