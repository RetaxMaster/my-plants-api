import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ProposalApplierService } from './proposal-applier.service.js';

type Args = Record<string, never> | Record<string, unknown>;

function harness(over: Record<string, unknown> = {}) {
  const tx = {
    doctorWriteProposal: { updateMany: vi.fn(async (_a: Args) => ({ count: 1 })) },
    plant: { findFirst: vi.fn(async (_a: Args) => ({ id: 'p1', ownerId: 'o1' })) },
    plantTaskFrequency: {
      upsert: vi.fn(async (_a: Args) => ({})),
      deleteMany: vi.fn(async (_a: Args) => ({ count: 1 })),
    },
    plantWriteAudit: { create: vi.fn(async (_a: Args) => ({})) },
    knowledgeChatSession: { update: vi.fn(async (_a: Args) => ({})) },
    ...over,
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const recompute = vi.fn(async (_id: string) => {});
  const svc = new ProposalApplierService(
    prisma as never,
    { recomputePlant: recompute } as never,
    { delete: vi.fn(async (_k: string) => {}) } as never,
    { deleteMany: vi.fn(async (_p: string[]) => {}) } as never,
    { enqueueTick: vi.fn() } as never,
  );
  return { svc, tx, prisma, recompute };
}

const proposal = {
  id: 'prop-1',
  sessionId: 's1',
  runId: 'r1',
  plantId: 'p1',
  ownerId: 'o1',
  operations: JSON.stringify([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]),
  snapshot: JSON.stringify([{ intervalDays: 7 }]),
};

describe('ProposalApplierService', () => {
  it('applies every operation and marks APPROVED in the same transaction', async () => {
    const { svc, tx } = harness();
    const res = await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(res.status).toBe('APPROVED');
    expect(tx.doctorWriteProposal.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'prop-1', status: 'PENDING' },
    });
    expect(tx.plantTaskFrequency.upsert).toHaveBeenCalled();
  });

  it('409s and applies nothing when the conditional status update affects 0 rows', async () => {
    const { svc, tx } = harness({
      doctorWriteProposal: { updateMany: vi.fn(async (_a: Args) => ({ count: 0 })) },
    });
    await expect(svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false })).rejects.toMatchObject({
      status: 409,
    });
    expect(tx.plantTaskFrequency.upsert).not.toHaveBeenCalled();
  });

  it('claims the proposal BEFORE performing any write', async () => {
    // The conditional claim is the lock. If any operation ran first, a losing actor would have already
    // mutated plant data by the time it discovered it lost the row — and the rollback of a partially
    // applied proposal is the only thing standing between that and a double-apply.
    const order: string[] = [];
    const { svc } = harness({
      doctorWriteProposal: {
        updateMany: vi.fn(async (_a: Args) => {
          order.push('claim');
          return { count: 1 };
        }),
      },
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          order.push('write');
          return {};
        }),
        deleteMany: vi.fn(async (_a: Args) => ({ count: 1 })),
      },
    });
    await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(order).toEqual(['claim', 'write']);
  });

  it('rolls everything back and marks FAILED with a sanitized reason when an operation throws', async () => {
    const { svc, prisma } = harness({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new Error('Unknown column secret_col');
        }),
      },
    });
    const res = await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(res.status).toBe('FAILED');
    expect(res.failureCode).toBe('INTERNAL');
    expect(res.failureReason).not.toContain('secret_col');
    // two transactions: the rolled-back apply, then the conditional FAILED write
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('marks an operation ConflictException as FAILED/CONFLICT rather than rethrowing it', async () => {
    // The applier must tell "I lost the claim on the proposal row" apart from "a write core reported a
    // conflict" (deleteProgressCore throws ConflictException when a photo is still processing). Both are
    // ConflictExceptions, so distinguishing them BY TYPE — as an earlier draft did — silently makes the
    // CONFLICT failure code unreachable: the proposal rolls back to PENDING, is never resolved, and the
    // agent is never told. The claim uses a private sentinel precisely so this branch stays reachable.
    const { svc, tx } = harness({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new ConflictException({ code: 'photo_processing', message: 'still processing' });
        }),
      },
    });
    const res = await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(res.status).toBe('FAILED');
    expect(res.failureCode).toBe('CONFLICT');
    expect(tx.knowledgeChatSession.update).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an outcome another actor already recorded, and ENQUEUES NOTHING', async () => {
    // Spec §5.7 step 3 + §10: when the rolled-back attempt finds the proposal already resolved, the
    // conditional FAILED write affects 0 rows and "returns 409 and enqueues nothing". The
    // enqueue-nothing half is the part that is easy to omit and impossible to notice later: a stray
    // system message would tell the agent its proposal failed when another actor had actually
    // APPROVED it, so the agent would re-propose a change that has already been applied.
    let call = 0;
    const updateMany = vi.fn(async (_a: Args) => ({ count: call++ === 0 ? 1 : 0 }));
    const { svc, tx } = harness({
      doctorWriteProposal: { updateMany },
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new Error('boom');
        }),
      },
    });
    await expect(svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false })).rejects.toMatchObject({
      status: 409,
    });
    expect(tx.knowledgeChatSession.update).not.toHaveBeenCalled();
  });

  it('enqueues the failure message ONLY when the conditional FAILED write wins the row', async () => {
    // The positive counterpart of the test above — otherwise "enqueues nothing" could be satisfied by
    // never enqueueing at all.
    const { svc, tx } = harness({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new Error('boom');
        }),
      },
    });
    const res = await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(res.status).toBe('FAILED');
    expect(tx.knowledgeChatSession.update).toHaveBeenCalledTimes(1);
    expect((tx.knowledgeChatSession.update.mock.calls[0]![0] as { data: { pendingSystemMessage: string } }).data
      .pendingSystemMessage).toBe(`[system] Your request could not be applied: ${res.failureReason}`);
  });

  it('records resolvedByUserId on FAILED: the failed approver, and NULL for a failed auto-apply', async () => {
    // Spec §5.2: "`resolvedByUserId` on a FAILED proposal is the actor whose approve attempt failed, and
    // null when the failure occurred during a skip-permissions auto-apply that no human triggered."
    // Both directions, because a single-direction test passes trivially if the field is always written.
    const boom = () => ({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new Error('boom');
        }),
      },
    });

    const human = harness(boom());
    await human.svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    const humanFailWrite = human.tx.doctorWriteProposal.updateMany.mock.calls.at(-1)![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(humanFailWrite.where).toMatchObject({ id: 'prop-1', status: 'PENDING' });
    expect(humanFailWrite.data).toMatchObject({ status: 'FAILED', pendingKey: null, resolvedByUserId: 'u1' });

    const auto = harness(boom());
    // A skip-permissions auto-apply that nobody triggered: no human actor.
    await auto.svc.apply(proposal as never, { actorUserId: null, autoApproved: true });
    const autoFailWrite = auto.tx.doctorWriteProposal.updateMany.mock.calls.at(-1)![0] as {
      data: Record<string, unknown>;
    };
    expect(autoFailWrite.data).toMatchObject({ status: 'FAILED', resolvedByUserId: null });
  });

  it('runs a care-plan recompute once even when several operations request it', async () => {
    const { svc, recompute } = harness();
    const multi = {
      ...proposal,
      operations: JSON.stringify([
        { type: 'frequency.set', task: 'WATER', intervalDays: 5 },
        { type: 'frequency.clear', task: 'MIST' },
      ]),
    };
    await svc.apply(multi as never, { actorUserId: 'u1', autoApproved: false });
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it('threads a DOCTOR AuditContext carrying the proposal id into every write core', async () => {
    // This is the property that makes the audit log answer "who changed this plant, and under what
    // authority". The AuditContext is also the ONLY thing the applier injects that the owner path does
    // not — if a second knob ever appears here, the core boundary is wrong (phase-1 ledger note).
    const { svc, tx } = harness();
    await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    const row = (tx.plantWriteAudit.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({ origin: 'DOCTOR', proposalId: 'prop-1', actorUserId: 'u1' });
  });

  it('does not run post-commit effects when the transaction rolled back', async () => {
    // The care plan is derived from committed rows. Recomputing after a rollback would rebuild it from
    // state the proposal never actually wrote.
    const { svc, recompute } = harness({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a: Args) => {
          throw new Error('boom');
        }),
      },
    });
    await svc.apply(proposal as never, { actorUserId: 'u1', autoApproved: false });
    expect(recompute).not.toHaveBeenCalled();
  });
});
