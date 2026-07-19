import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Task, type Prisma } from '@prisma/client';
import { writeOriginAudit, type AuditContext } from '../audit/origin-audit.js';
import { emptyEffects, type WriteEffects } from '../common/write-effects.js';

/**
 * Frequency-bearing tasks only (PROGRESS excluded — fixed weekly cadence). It lives HERE, beside the
 * writes it guards, so the service and the proposal applier share one list rather than two that drift.
 */
export const FREQUENCY_TASKS = new Set<Task>([
  Task.WATER,
  Task.FERTILIZE,
  Task.REPOT,
  Task.ROTATE,
  Task.CLEAN_LEAVES,
  Task.MIST,
]);

export type CoreResult<T> = { result: T; effects: WriteEffects };

/**
 * Defense in depth: the DTO already rejects PROGRESS, but every write path must also refuse it (and any
 * non-frequency-bearing task) so the invariant holds regardless of caller — never upsert a PROGRESS
 * PlantTaskFrequency the engine would ignore. Checked BEFORE any read or write.
 */
function assertFrequencyTask(task: string): asserts task is Task {
  if (!FREQUENCY_TASKS.has(task as Task)) {
    throw new BadRequestException(`Not a frequency-bearing task: ${task}`);
  }
}

async function assertOwned(tx: Prisma.TransactionClient, plantId: string, ownerId: string): Promise<void> {
  const owned = await tx.plant.findFirst({ where: { id: plantId, ownerId }, select: { id: true } });
  if (!owned) throw new NotFoundException(`Unknown plant: ${plantId}`);
}

/** The single implementation of "set a per-plant task cadence override". */
export async function setFrequencyCore(
  tx: Prisma.TransactionClient,
  input: { plantId: string; ownerId: string; task: string; intervalDays: number; audit: AuditContext },
): Promise<CoreResult<{ task: string }>> {
  assertFrequencyTask(input.task);
  await assertOwned(tx, input.plantId, input.ownerId);

  await tx.plantTaskFrequency.upsert({
    where: { plantId_task: { plantId: input.plantId, task: input.task } },
    create: { plantId: input.plantId, task: input.task, intervalDays: input.intervalDays },
    update: { intervalDays: input.intervalDays },
  });
  await writeOriginAudit(tx, {
    plantId: input.plantId,
    ownerId: input.ownerId,
    origin: input.audit.origin,
    proposalId: input.audit.proposalId,
    actorUserId: input.audit.actorUserId,
    operationType: 'frequency.set',
    targetTable: 'plant_task_frequencies',
    targetId: input.task,
    payload: { task: input.task, intervalDays: input.intervalDays },
  });

  const effects = emptyEffects();
  effects.recomputePlantIds.push(input.plantId);
  return { result: { task: input.task }, effects };
}

/** The single implementation of "drop a per-plant task cadence override, back to the species default". */
export async function clearFrequencyCore(
  tx: Prisma.TransactionClient,
  input: { plantId: string; ownerId: string; task: string; audit: AuditContext },
): Promise<CoreResult<{ task: string }>> {
  assertFrequencyTask(input.task);
  await assertOwned(tx, input.plantId, input.ownerId);

  const deleted = await tx.plantTaskFrequency.deleteMany({
    where: { plantId: input.plantId, task: input.task },
  });

  // No row deleted → nothing was written → no audit row (same rule as the other cores). The recompute
  // still runs regardless: it is idempotent, and it is what the pre-refactor service did.
  if (deleted.count > 0) {
    await writeOriginAudit(tx, {
      plantId: input.plantId,
      ownerId: input.ownerId,
      origin: input.audit.origin,
      proposalId: input.audit.proposalId,
      actorUserId: input.audit.actorUserId,
      operationType: 'frequency.clear',
      targetTable: 'plant_task_frequencies',
      targetId: input.task,
      payload: { task: input.task },
    });
  }

  const effects = emptyEffects();
  effects.recomputePlantIds.push(input.plantId);
  return { result: { task: input.task }, effects };
}
