import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { DoctorWriteProposal, Prisma, Task, CareEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CarePlanService } from '../../care-plan/care-plan.service.js';
import { ImageUploadService } from '../../storage/image-upload.service.js';
import { PhotoInboxService } from '../../storage/photo-inbox.service.js';
import { PhotoWorkerService } from '../../photo-worker/photo-worker.service.js';
import { emptyEffects, mergeEffects, runEffects, type WriteEffects } from '../../common/write-effects.js';
import { updatePlantCore, updateProfileCore } from '../../plants/plants.write-core.js';
import { createProgressCore, updateProgressCore, deleteProgressCore } from '../../progress/progress.write-core.js';
import { setFrequencyCore, clearFrequencyCore } from '../../frequency/frequency.write-core.js';
import { recordFeedbackCore } from '../../feedback/feedback.write-core.js';
import { ymdToUtcDate, startOfTodayUtc } from '../../common/time/local-date.js';
import type { ProposalOperation } from './proposal-operations.schema.js';
import { classifyFailure, type ProposalFailureCode } from './proposal-failure.js';
import { SYSTEM_MESSAGE } from '../../knowledge-chat/system-message.js';
import type { AuditContext } from '../../audit/origin-audit.js';

export type ApplyOutcome = {
  status: 'APPROVED' | 'FAILED';
  failureCode?: ProposalFailureCode;
  failureReason?: string;
};

/**
 * Raised when the conditional PENDING claim affects 0 rows — i.e. another actor already resolved this
 * proposal.
 *
 * It is deliberately NOT a `ConflictException`. The applier must tell this apart from a conflict
 * reported by a WRITE CORE (`deleteProgressCore` throws `ConflictException` when a photo is mid-upload),
 * and both would otherwise be the same type. Branching on the type — as an earlier draft did — makes the
 * `CONFLICT` failure code unreachable: a genuine core conflict propagates to the caller, the rollback
 * leaves the proposal PENDING forever, and the agent is never told why nothing happened. A private
 * sentinel keeps the two apart; it is converted to a 409 at the public boundary.
 */
class ProposalAlreadyResolvedError extends Error {
  constructor() {
    super('proposal is no longer pending');
  }
}

@Injectable()
export class ProposalApplierService {
  private readonly logger = new Logger(ProposalApplierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly carePlan: CarePlanService,
    private readonly images: ImageUploadService,
    private readonly inbox: PhotoInboxService,
    private readonly worker: PhotoWorkerService,
  ) {}

  /**
   * All-or-nothing (spec 5.7). One transaction performs the conditional PENDING -> APPROVED
   * transition AND every operation's write core, so a rollback of the writes also rolls back
   * the status. Post-commit effects run afterwards, de-duplicated, and never un-apply.
   */
  async apply(
    proposal: DoctorWriteProposal,
    ctx: { actorUserId: string | null; autoApproved: boolean },
  ): Promise<ApplyOutcome> {
    const operations = JSON.parse(proposal.operations) as ProposalOperation[];
    const audit: AuditContext = { origin: 'DOCTOR', proposalId: proposal.id, actorUserId: ctx.actorUserId };

    let effects: WriteEffects = emptyEffects();
    try {
      effects = await this.prisma.$transaction(async (tx) => {
        // The claim LEADS the transaction: nothing may be written before we own the row, or a losing
        // actor would mutate plant data and depend entirely on the rollback to undo it.
        const claimed = await tx.doctorWriteProposal.updateMany({
          where: { id: proposal.id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            pendingKey: null,
            autoApproved: ctx.autoApproved,
            resolvedAt: new Date(),
            resolvedByUserId: ctx.actorUserId,
          },
        });
        if (claimed.count === 0) throw new ProposalAlreadyResolvedError();

        const collected: WriteEffects[] = [];
        for (const op of operations) collected.push(await this.applyOne(tx, proposal, op, audit));
        return mergeEffects(collected);
      });
    } catch (err) {
      if (err instanceof ProposalAlreadyResolvedError) throw new ConflictException(err.message);
      return this.markFailed(proposal, err, ctx);
    }

    await runEffects(effects, {
      recomputePlant: (id) => this.carePlan.recomputePlant(id),
      deleteObject: (key) => this.images.delete(key),
      deleteInboxPaths: (paths) => this.inbox.deleteMany(paths),
      enqueuePhotoTick: () => this.worker.enqueueTick(),
      logger: this.logger,
    });

    return { status: 'APPROVED' };
  }

  /**
   * Dispatch one operation to its write core.
   *
   * The AuditContext is the ONLY thing this injects that the owner's HTTP path does not — that is the
   * phase-1 contract, and it is what guarantees an approved proposal and an owner edit take literally
   * the same code path. If a second per-caller knob ever seems necessary here, the core boundary is
   * wrong; do not add a flag.
   *
   * ⚠️ `photos` and `removePhotoIds` are ALWAYS empty: a proposal cannot carry image data (the
   * operations union has no photo field). This is load-bearing beyond tidiness. `updateProgressCore`
   * reads its photo rows with a NON-locking SELECT after taking the entry lock, and an earlier
   * operation in this same transaction (any core's plain ownership `findFirst`) has already established
   * the InnoDB REPEATABLE READ snapshot — so that photo read can be stale here in a way it never is on
   * the single-operation owner path. With nothing added and nothing removed the ≤8-photo invariant
   * cannot be crossed and the claim guard cannot misfire, so the staleness is inert. Should a photo-
   * bearing operation ever be added to the union, that stops being true and the lock ordering must be
   * revisited FIRST — see the phase-1 ledger note on the read-view hazard.
   */
  private async applyOne(
    tx: Prisma.TransactionClient,
    proposal: DoctorWriteProposal,
    op: ProposalOperation,
    audit: AuditContext,
  ): Promise<WriteEffects> {
    const base = { plantId: proposal.plantId, ownerId: proposal.ownerId, audit };
    switch (op.type) {
      case 'profile.update': {
        const { type: _t, ...patch } = op;
        return (await updateProfileCore(tx, { ...base, patch })).effects;
      }
      case 'plant.update': {
        const { type: _t, ...patch } = op;
        return (await updatePlantCore(tx, { ...base, patch })).effects;
      }
      case 'progress.create':
        return (
          await createProgressCore(tx, {
            ...base,
            data: {
              health: op.health,
              // Frozen at propose time when the agent supplied it. When it did not, "today" is resolved
              // at APPLY time — the same rule the owner's own endpoint uses — because a proposal may sit
              // pending across a midnight and the entry belongs to the day it is actually recorded.
              occurredOn: op.occurredOn ? ymdToUtcDate(op.occurredOn) : await this.todayForPlant(tx, proposal.plantId),
              observations: op.observations ?? null,
              sizeCm: op.sizeCm ?? null,
              tags: op.tags ?? [],
            },
            photos: [],
          })
        ).effects;
      case 'progress.update': {
        const data: Record<string, unknown> = {};
        for (const k of ['health', 'observations', 'sizeCm', 'tags'] as const) if (k in op) data[k] = op[k];
        if (op.occurredOn !== undefined) data.occurredOn = ymdToUtcDate(op.occurredOn);
        return (
          await updateProgressCore(tx, {
            ...base,
            entryId: op.entryId,
            data: data as never,
            photos: [],
            removePhotoIds: [],
          })
        ).effects;
      }
      case 'progress.delete':
        return (await deleteProgressCore(tx, { ...base, entryId: op.entryId })).effects;
      case 'frequency.set':
        return (await setFrequencyCore(tx, { ...base, task: op.task, intervalDays: op.intervalDays })).effects;
      case 'frequency.clear':
        return (await clearFrequencyCore(tx, { ...base, task: op.task })).effects;
      case 'care.done':
        return (
          await recordFeedbackCore(tx, {
            ...base,
            task: op.task as Task,
            type: 'DONE' as CareEventType,
            occurredOn: ymdToUtcDate(op.occurredOn),
          })
        ).effects;
    }
  }

  /** Today in the plant's own place-city timezone — the same resolution ProgressService performs. */
  private async todayForPlant(tx: Prisma.TransactionClient, plantId: string): Promise<Date> {
    const plant = await tx.plant.findFirst({
      where: { id: plantId },
      select: { place: { select: { city: { select: { timezone: true } } } } },
    });
    return startOfTodayUtc(plant?.place?.city?.timezone ?? 'UTC');
  }

  /**
   * The rollback undid the PENDING -> APPROVED transition, so the row is PENDING again and
   * another actor may legitimately have won it. The FAILED write is therefore conditional and
   * its count is authoritative: 0 rows means DO NOT overwrite that outcome (spec 5.7 item 3).
   */
  private async markFailed(
    proposal: DoctorWriteProposal,
    err: unknown,
    ctx: { actorUserId: string | null; autoApproved: boolean },
  ): Promise<ApplyOutcome> {
    const { code, reason } = classifyFailure(err, this.logger);
    const won = await this.prisma.$transaction(async (tx) => {
      const res = await tx.doctorWriteProposal.updateMany({
        where: { id: proposal.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          pendingKey: null,
          failureCode: code,
          failureReason: reason,
          resolvedAt: new Date(),
          // null when no human triggered the attempt (a skip-permissions auto-apply)
          resolvedByUserId: ctx.autoApproved ? null : ctx.actorUserId,
        },
      });
      if (res.count === 1) {
        // Enqueue the failure nudge INSIDE the same transaction, only when we won the row.
        await tx.knowledgeChatSession.update({
          where: { id: proposal.sessionId },
          data: {
            pendingSystemMessage: SYSTEM_MESSAGE.failed(reason),
            pendingSystemMessageProposalId: proposal.id,
          },
        });
      }
      return res.count;
    });

    if (won === 0) throw new ConflictException('proposal was already resolved by another actor');
    return { status: 'FAILED', failureCode: code, failureReason: reason };
  }
}
