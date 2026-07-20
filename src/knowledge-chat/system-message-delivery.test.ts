import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { classifyLaunchFailure, restoreOnPreSpawnFailure, settleConsumedMessage } from './system-message-delivery.js';
import { EngineFailureException } from './engine/engine-error.js';

describe('classifyLaunchFailure', () => {
  it('treats a connection refusal and a 4xx rejection as CONFIRMED pre-spawn', () => {
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('PRE_SPAWN');
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('PRE_SPAWN');
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { status: 422 }))).toBe('PRE_SPAWN');
  });

  // ⚠️ THIS FIXTURE IS OBSERVED, NOT AUTHORED — and that distinction is the whole point of the test.
  //
  // The hand-built `{ code: 'ECONNREFUSED' }` fixture above is a shape the production error NEVER has.
  // `execute()` calls the global `fetch` (undici), which rejects with `TypeError: fetch failed` carrying
  // `code: undefined` and the syscall code one level down on `cause`. So the assertion above passed while
  // the branch was dead on the only path it exists for. This test gets its error from a REAL rejected
  // fetch against a closed port, which is the only way to keep the two in sync.
  it('classifies a REAL undici fetch rejection (engine down) as PRE_SPAWN, not AMBIGUOUS', async () => {
    // Bind port 0 to have the OS pick a free port, then close it — so the port is known-closed, and the
    // test cannot flake by colliding with a real listener.
    const probe = createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', res));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));

    const err = await fetch(`http://127.0.0.1:${port}/execute`).then(
      () => null,
      (e: unknown) => e,
    );

    // Guard the guard: if this ever stops being the nested shape, the test must say so loudly rather than
    // quietly re-passing for the wrong reason.
    expect(err).toBeInstanceOf(TypeError);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as { cause?: { code?: unknown } }).cause?.code).toBe('ECONNREFUSED');

    expect(classifyLaunchFailure(err)).toBe('PRE_SPAWN');
  });

  it('finds a pre-spawn code nested deeper, and terminates on a cyclic cause chain', () => {
    const deep = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('mid'), { cause: Object.assign(new Error('inner'), { code: 'ENOTFOUND' }) }),
    });
    expect(classifyLaunchFailure(deep)).toBe('PRE_SPAWN');

    // Undici can wrap several connection attempts; every branch must be inspected.
    const aggregate = Object.assign(new Error('fetch failed'), {
      cause: new AggregateError([new Error('ipv6 attempt'), Object.assign(new Error('ipv4'), { code: 'ECONNREFUSED' })]),
    });
    expect(classifyLaunchFailure(aggregate)).toBe('PRE_SPAWN');

    // A cyclic chain must return, not hang — this runs on the failure path of a live outage.
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifyLaunchFailure(a)).toBe('AMBIGUOUS');
  });

  it('treats a timeout, a lost response and a 5xx as AMBIGUOUS', () => {
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('AMBIGUOUS');
    expect(classifyLaunchFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('AMBIGUOUS');
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { status: 502 }))).toBe('AMBIGUOUS');
  });

  it('defaults an UNRECOGNISED failure to AMBIGUOUS — never to PRE_SPAWN', () => {
    // The asymmetry is deliberate and load-bearing. PRE_SPAWN restores the message; guessing it wrong
    // re-delivers a nudge the agent already received, which it reads as a SECOND refusal. AMBIGUOUS
    // merely defers to reconciliation. When we do not know, the safe default is the one that cannot
    // duplicate.
    expect(classifyLaunchFailure(new Error('something nobody anticipated'))).toBe('AMBIGUOUS');
    expect(classifyLaunchFailure(undefined)).toBe('AMBIGUOUS');
    expect(classifyLaunchFailure(null)).toBe('AMBIGUOUS');
  });

  it('classifies a mapped engine 4xx as a CONFIRMED pre-spawn failure', () => {
    expect(classifyLaunchFailure(new EngineFailureException({ code: 'attachment_too_large', status: 413 })))
      .toBe('PRE_SPAWN');
    expect(classifyLaunchFailure(new EngineFailureException({ code: 'request_failed', status: 422 })))
      .toBe('PRE_SPAWN');
  });

  it('leaves a 5xx AMBIGUOUS — the run may already have spawned', () => {
    expect(classifyLaunchFailure(new EngineFailureException({ code: 'request_failed', status: 503 })))
      .toBe('AMBIGUOUS');
  });
});

const consumedRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  sessionId: 's1',
  systemMessageText: 'msg',
  systemMessageProposalId: null,
  systemMessageState: 'CONSUMED',
  ...over,
});

/**
 * ⚠️ A REAL IN-MEMORY SESSION ROW, not a static stub.
 *
 * The slot claim is now a CONDITIONAL `updateMany ... where pendingSystemMessage: null`, and the whole
 * point of that condition is to decide RESTORED vs DROPPED atomically. A double that ignores the `where`
 * and always reports `count: 1` would go green for the correct implementation AND for the read-then-write
 * version that loses a newer message — i.e. it could not fail the property it is used to prove.
 *
 * So the fake EVALUATES the filter against stored state, and the assertions read the resulting state.
 */
function txWith(session: Record<string, unknown> | null, runFindUnique?: unknown) {
  const sessionRow: Record<string, unknown> | null = session
    ? { pendingSystemMessageProposalId: null, ...session }
    : null;
  const runRow = (runFindUnique ?? null) as Record<string, unknown> | null;
  return {
    knowledgeChatRun: {
      findUnique: vi.fn(async () => runRow),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (runRow && where.systemMessageState && runRow.systemMessageState !== where.systemMessageState) {
          return { count: 0 };
        }
        if (runRow) Object.assign(runRow, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (runRow) Object.assign(runRow, data);
        return runRow ?? {};
      }),
    },
    knowledgeChatSession: {
      findUnique: vi.fn(async () => sessionRow),
      // Honours the `pendingSystemMessage: null` guard — this is the mechanism under test.
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!sessionRow) return { count: 0 };
        if ('pendingSystemMessage' in where && sessionRow.pendingSystemMessage !== where.pendingSystemMessage) {
          return { count: 0 };
        }
        Object.assign(sessionRow, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (sessionRow) Object.assign(sessionRow, data);
        return sessionRow ?? {};
      }),
    },
    _session: sessionRow,
    _run: runRow,
  } as never as {
    knowledgeChatRun: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    knowledgeChatSession: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    _session: Record<string, unknown> | null;
    _run: Record<string, unknown> | null;
  };
}

describe('restoreOnPreSpawnFailure', () => {
  it('restores the message in the SAME transaction that frees activeKey', async () => {
    const tx = txWith(
      { id: 's1', pendingSystemMessage: null },
      consumedRun({ systemMessageProposalId: 'p1' }),
    );
    await restoreOnPreSpawnFailure(tx as never, 'r1', 'boom');
    const runUpdate = tx.knowledgeChatRun.updateMany.mock.calls[0][0];
    expect(runUpdate.where).toMatchObject({ id: 'r1', systemMessageState: 'CONSUMED' });
    expect(runUpdate.data).toMatchObject({ status: 'FAILED', activeKey: null, systemMessageState: 'RESTORED' });
    expect(tx._session!.pendingSystemMessage).toBe('msg');
    // The proposal id travels back with its text, or the restored message loses what it refers to.
    expect(tx._session!.pendingSystemMessageProposalId).toBe('p1');
  });

  it('drops the older message when a newer one already occupies the slot', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: 'newer' }, consumedRun({ systemMessageText: 'old' }));
    await restoreOnPreSpawnFailure(tx as never, 'r1', 'boom');
    // The run must END as DROPPED, and the newer message must survive untouched.
    expect(tx._run!.systemMessageState).toBe('DROPPED');
    expect(tx._session!.pendingSystemMessage).toBe('newer');
  });

  it('still marks a run carrying NO message FAILED and frees its activeKey', async () => {
    // The common case by far — most launches carry no system message. A version of this that only
    // handled the message would silently leave ordinary failed launches holding the active slot,
    // blocking the session forever.
    const tx = txWith({ id: 's1', pendingSystemMessage: null }, consumedRun({ systemMessageState: null, systemMessageText: null }));
    await restoreOnPreSpawnFailure(tx as never, 'r1', 'boom');
    const call = tx.knowledgeChatRun.updateMany.mock.calls.at(-1)![0];
    expect(call.data).toMatchObject({ status: 'FAILED', activeKey: null });
    expect(tx.knowledgeChatSession.update).not.toHaveBeenCalled();
  });

  it('does nothing for a run that no longer exists', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: null }, null);
    await restoreOnPreSpawnFailure(tx as never, 'r1', 'boom');
    expect(tx.knowledgeChatRun.updateMany).not.toHaveBeenCalled();
  });
});

describe('settleConsumedMessage', () => {
  it('RESTOREs when the run produced no agent turn', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: null });
    await settleConsumedMessage(tx as never, consumedRun(), { producedAgentTurn: false });
    expect(tx.knowledgeChatRun.updateMany.mock.calls[0][0].data.systemMessageState).toBe('RESTORED');
    expect(tx._session!.pendingSystemMessage).toBe('msg');
  });

  // ⚠️ THE RACE THE OLD FAKE COULD NOT EXPRESS. The previous double returned a STATIC session object, so
  // no test could put a write between the slot read and the slot write — which is precisely where the
  // defect lived: read slot (empty) -> a newer message commits -> overwrite it with the older one, losing
  // the newer notification for good. The conditional claim closes it, and this proves the claim is what
  // does the work: the write lands BETWEEN the two statements.
  it('never overwrites a message that arrives AFTER the slot was read as empty', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: null }, consumedRun({ systemMessageText: 'old' }));
    // Simulate a concurrent decline committing a NEWER message the instant the run row is settled —
    // i.e. after any read of the slot, before the restore would write it.
    const realRunUpdateMany = tx.knowledgeChatRun.updateMany.getMockImplementation()!;
    tx.knowledgeChatRun.updateMany.mockImplementation(async (args: never) => {
      const res = await realRunUpdateMany(args);
      tx._session!.pendingSystemMessage = 'newer';
      tx._session!.pendingSystemMessageProposalId = 'p-newer';
      return res;
    });

    await settleConsumedMessage(tx as never, consumedRun({ systemMessageText: 'old' }), { producedAgentTurn: false });

    // The newer message SURVIVES, and the older one is recorded as DROPPED rather than silently lost.
    expect(tx._session!.pendingSystemMessage).toBe('newer');
    expect(tx._session!.pendingSystemMessageProposalId).toBe('p-newer');
    expect(tx._run!.systemMessageState).toBe('DROPPED');
  });

  it('marks it DELIVERED when the run did produce a turn — and restores nothing', async () => {
    // A delivered message must never go back on the session: the agent already read it, and re-queueing
    // it would reach the agent as a SECOND refusal for the same proposal.
    const tx = txWith({ id: 's1', pendingSystemMessage: null });
    await settleConsumedMessage(tx as never, consumedRun(), { producedAgentTurn: true });
    expect(tx.knowledgeChatRun.updateMany.mock.calls[0][0].data.systemMessageState).toBe('DELIVERED');
    expect(tx.knowledgeChatSession.update).not.toHaveBeenCalled();
  });

  it('is idempotent: a second invocation affects 0 rows and restores nothing', async () => {
    // The conditional `where systemMessageState = 'CONSUMED'` is the entire guarantee. Reconciliation and
    // the engine callback can both fire for the same run; exactly one may settle it.
    const tx = txWith({ id: 's1', pendingSystemMessage: null });
    tx.knowledgeChatRun.updateMany.mockResolvedValue({ count: 0 });
    await settleConsumedMessage(tx as never, consumedRun(), { producedAgentTurn: false });
    expect(tx.knowledgeChatSession.update).not.toHaveBeenCalled();
  });

  it('does nothing for a run that carries no consumed message', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: null });
    await settleConsumedMessage(tx as never, consumedRun({ systemMessageState: null, systemMessageText: null }), {
      producedAgentTurn: false,
    });
    expect(tx.knowledgeChatRun.updateMany).not.toHaveBeenCalled();
  });

  it('does not re-settle a message already RESTORED or DELIVERED', async () => {
    for (const state of ['RESTORED', 'DELIVERED', 'DROPPED']) {
      const tx = txWith({ id: 's1', pendingSystemMessage: null });
      await settleConsumedMessage(tx as never, consumedRun({ systemMessageState: state }), {
        producedAgentTurn: false,
      });
      expect(tx.knowledgeChatRun.updateMany, `state ${state}`).not.toHaveBeenCalled();
    }
  });
});
