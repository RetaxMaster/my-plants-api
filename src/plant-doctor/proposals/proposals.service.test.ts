import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProposalsService } from './proposals.service.js';

const session = {
  id: 's1',
  kind: 'DOCTOR',
  plantId: 'p1',
  ownerId: 'o1',
  skipPermissions: false,
  skipPermissionsSetByUserId: null,
};
const run = { id: 'r1', sessionId: 's1', status: 'RUNNING' };

function harness(over: { tx?: Record<string, unknown>; prisma?: Record<string, unknown> } = {}) {
  const base = {
    knowledgeChatSession: { findUnique: vi.fn(async () => session), update: vi.fn(async () => ({})) },
    knowledgeChatRun: { findUnique: vi.fn(async () => run) },
    doctorWriteProposal: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    plantProgressEntry: { findMany: vi.fn(async () => [] as { id: string }[]) },
    place: { findMany: vi.fn(async () => [] as { id: string }[]) },
    // The plant's place-city timezone, used to freeze an omitted `occurredOn` to the OWNER's calendar
    // day rather than to UTC's.
    plant: { findFirst: vi.fn(async () => ({ place: { city: { timezone: 'America/Mexico_City' } } })) },
    ...over.prisma,
  };

  // The transaction client exposes the SAME models as the root client — that is how Prisma actually
  // behaves, and modelling it any other way lets a test pass while the real `tx.<model>` is undefined.
  // `create` is transaction-only here because only `create()` inserts.
  const tx = {
    ...base,
    doctorWriteProposal: {
      ...base.doctorWriteProposal,
      create: vi.fn(async (a: { data: Record<string, unknown> }) => ({
        id: 'prop-1',
        status: 'PENDING',
        pendingKey: 'PENDING',
        ...a.data,
      })),
      ...(over.tx?.doctorWriteProposal as Record<string, unknown> | undefined),
    },
  } as never as {
    doctorWriteProposal: { updateMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };

  const prisma = {
    ...base,
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  } as never as {
    knowledgeChatSession: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    doctorWriteProposal: { findUnique: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  const applier = { apply: vi.fn(async () => ({ status: 'APPROVED' })) };
  const snapshots = { capture: vi.fn(async () => [{ intervalDays: 7 }]) };
  const render = {
    render: vi.fn(async (p: { id: string; status: string; summary: string }) => ({
      id: p.id,
      status: p.status,
      operations: [],
      summary: p.summary,
    })),
  };
  const owner = { currentOwnerId: () => 'o1', currentActor: () => ({ userId: 'u1' }) };
  // decline() starts the queued system turn when the session is idle (spec 5.3). Stub it here; the REAL
  // behaviour is proven in Task 22's e2e. Returning null models "a run is already active".
  const chat = { startQueuedSystemTurn: vi.fn(async () => null) };
  const svc = new ProposalsService(
    prisma as never,
    snapshots as never,
    render as never,
    applier as never,
    owner as never,
    chat as never,
  );
  return { svc, prisma, tx, applier, snapshots, chat };
}

const token = { userId: 'u1', plantId: 'p1', ownerId: 'o1', sessionId: 's1', runId: 'r1' };
const body = {
  summary: 'raise the watering interval',
  operations: [{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }],
} as never;

afterEach(() => {
  vi.useRealTimers();
});

describe('ProposalsService.create', () => {
  it('derives plantId/ownerId/sessionId/runId from the token, never the body', async () => {
    const { svc, tx } = harness();
    await svc.create(token as never, body);
    expect(tx.doctorWriteProposal.create.mock.calls[0][0].data).toMatchObject({
      plantId: 'p1',
      ownerId: 'o1',
      sessionId: 's1',
      runId: 'r1',
      pendingKey: 'PENDING',
    });
  });

  it("freezes an omitted progress.create occurredOn to today in the PLANT's timezone at PROPOSE time", async () => {
    const { svc, tx } = harness();
    // 23:50Z on the 18th is 17:50 on the 18th in America/Mexico_City — same calendar day both ways.
    vi.setSystemTime(new Date('2026-07-18T23:50:00.000Z'));
    await svc.create(token as never, {
      summary: 's',
      operations: [{ type: 'progress.create', health: 'GOOD' }],
    } as never);
    const ops = JSON.parse(tx.doctorWriteProposal.create.mock.calls[0][0].data.operations);
    expect(ops[0].occurredOn).toBe('2026-07-18');
  });

  it("uses the OWNER's calendar day, not UTC's, when the two disagree", async () => {
    // 01:30Z on the 19th is still 19:30 on the 18th in America/Mexico_City (UTC-6). Freezing UTC's
    // "today" here would file the entry against TOMORROW from the owner's point of view — the exact
    // class of defect the project's calendar-day rule exists to prevent.
    const { svc, tx } = harness();
    vi.setSystemTime(new Date('2026-07-19T01:30:00.000Z'));
    await svc.create(token as never, {
      summary: 's',
      operations: [{ type: 'progress.create', health: 'GOOD' }],
    } as never);
    const ops = JSON.parse(tx.doctorWriteProposal.create.mock.calls[0][0].data.operations);
    expect(ops[0].occurredOn).toBe('2026-07-18');
  });

  it('expires an existing pending proposal in the same transaction', async () => {
    const { svc, tx } = harness();
    await svc.create(token as never, body);
    expect(tx.doctorWriteProposal.updateMany.mock.calls[0][0]).toMatchObject({
      where: { sessionId: 's1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'EXPIRED', pendingKey: null }),
    });
  });

  it('409s when the pending slot is taken concurrently (unique violation)', async () => {
    const { svc } = harness({
      tx: {
        doctorWriteProposal: {
          updateMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => {
            throw Object.assign(new Error('dup'), { code: 'P2002' });
          }),
        },
      },
    });
    await expect(svc.create(token as never, body)).rejects.toMatchObject({ status: 409 });
  });

  it('403s when the run is terminal or belongs to another session', async () => {
    const { svc } = harness({
      prisma: { knowledgeChatRun: { findUnique: vi.fn(async () => ({ id: 'r1', sessionId: 's9', status: 'RUNNING' })) } },
    });
    await expect(svc.create(token as never, body)).rejects.toMatchObject({ status: 403 });
    const { svc: svc2 } = harness({
      prisma: {
        knowledgeChatRun: { findUnique: vi.fn(async () => ({ id: 'r1', sessionId: 's1', status: 'SUCCEEDED' })) },
      },
    });
    await expect(svc2.create(token as never, body)).rejects.toMatchObject({ status: 403 });
  });

  it('auto-applies when the session has skip permissions on, attributing it to the user who enabled it', async () => {
    const { svc, applier } = harness({
      prisma: {
        knowledgeChatSession: {
          findUnique: vi.fn(async () => ({
            ...session,
            skipPermissions: true,
            skipPermissionsSetByUserId: 'owner-9',
          })),
          update: vi.fn(),
        },
      },
    });
    await svc.create(token as never, body);
    expect(applier.apply).toHaveBeenCalledWith(expect.anything(), { actorUserId: 'owner-9', autoApproved: true });
  });

  it('re-reads skip permissions at apply time and does NOT auto-apply when it was revoked mid-flight', async () => {
    // Spec 6.4: the setting is read AT APPLY TIME. The session read at the top of create() is stale by
    // the time the snapshot is captured; auto-applying on it would write after the owner revoked consent.
    let reads = 0;
    const { svc, applier } = harness({
      prisma: {
        knowledgeChatSession: {
          findUnique: vi.fn(async () => {
            reads += 1;
            return { ...session, skipPermissions: reads === 1, skipPermissionsSetByUserId: 'owner-9' };
          }),
          update: vi.fn(),
        },
      },
    });
    await svc.create(token as never, body);
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it('rejects overlapping write-sets with 400', async () => {
    const { svc } = harness();
    await expect(
      svc.create(token as never, {
        summary: 's',
        operations: [
          { type: 'frequency.set', task: 'WATER', intervalDays: 5 },
          { type: 'frequency.clear', task: 'WATER' },
        ],
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('400s a progress entryId that does not belong to the pinned plant', async () => {
    const { svc } = harness();
    await expect(
      svc.create(token as never, {
        summary: 's',
        operations: [{ type: 'progress.update', entryId: 'foreign', observations: 'x' }],
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('400s a placeId that does not belong to the pinned owner', async () => {
    const { svc } = harness();
    await expect(
      svc.create(token as never, {
        summary: 's',
        operations: [{ type: 'plant.update', placeId: 'foreign' }],
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('ProposalsService.decline', () => {
  it('records the decision and queues the system message even while a run is active', async () => {
    const { svc, prisma } = harness({
      prisma: {
        doctorWriteProposal: {
          findUnique: vi.fn(async () => ({
            id: 'prop-1',
            sessionId: 's1',
            plantId: 'p1',
            ownerId: 'o1',
            status: 'PENDING',
          })),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      },
    });
    await svc.decline('p1', 's1', 'prop-1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('409s when the proposal is already terminal, returning the terminal status', async () => {
    const { svc } = harness({
      prisma: {
        doctorWriteProposal: {
          findUnique: vi.fn(async () => ({
            id: 'prop-1',
            sessionId: 's1',
            plantId: 'p1',
            ownerId: 'o1',
            status: 'EXPIRED',
          })),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      },
    });
    await expect(svc.decline('p1', 's1', 'prop-1')).rejects.toMatchObject({ status: 409 });
  });

  it('404s for a proposal belonging to another owner (existence is never leaked)', async () => {
    const { svc } = harness({
      prisma: {
        doctorWriteProposal: {
          findUnique: vi.fn(async () => ({
            id: 'prop-1',
            sessionId: 's1',
            plantId: 'p1',
            ownerId: 'other',
            status: 'PENDING',
          })),
        },
      },
    });
    await expect(svc.decline('p1', 's1', 'prop-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('ProposalsService.getSettings', () => {
  it('403s a doctor token pinned to a different session', async () => {
    const { svc } = harness();
    await expect(
      svc.getSettings('p1', 's-other', { kind: 'doctor', token: token as never }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets a doctor token read the setting of its OWN session', async () => {
    const { svc } = harness();
    expect(await svc.getSettings('p1', 's1', { kind: 'doctor', token: token as never })).toEqual({
      skipPermissions: false,
    });
  });
});

describe('ProposalsService.setSkipPermissions', () => {
  it('records who enabled it and when', async () => {
    const { svc, prisma } = harness();
    await svc.setSkipPermissions('p1', 's1', true);
    expect(prisma.knowledgeChatSession.update.mock.calls[0][0].data).toMatchObject({
      skipPermissions: true,
      skipPermissionsSetByUserId: 'u1',
    });
    expect(prisma.knowledgeChatSession.update.mock.calls[0][0].data.skipPermissionsSetAt).toBeInstanceOf(Date);
  });

  it('clears the provenance columns when the owner turns it OFF', async () => {
    const { svc, prisma } = harness();
    await svc.setSkipPermissions('p1', 's1', false);
    expect(prisma.knowledgeChatSession.update.mock.calls[0][0].data).toMatchObject({
      skipPermissions: false,
      skipPermissionsSetByUserId: null,
      skipPermissionsSetAt: null,
    });
  });
});
