import { describe, it, expect, vi } from 'vitest';
import { classifyLaunchFailure, restoreOnPreSpawnFailure, settleConsumedMessage } from './system-message-delivery.js';

describe('classifyLaunchFailure', () => {
  it('treats a connection refusal and a 4xx rejection as CONFIRMED pre-spawn', () => {
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('PRE_SPAWN');
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('PRE_SPAWN');
    expect(classifyLaunchFailure(Object.assign(new Error('x'), { status: 422 }))).toBe('PRE_SPAWN');
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
});

const consumedRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  sessionId: 's1',
  systemMessageText: 'msg',
  systemMessageProposalId: null,
  systemMessageState: 'CONSUMED',
  ...over,
});

function txWith(session: Record<string, unknown> | null, runFindUnique?: unknown) {
  return {
    knowledgeChatRun: {
      findUnique: vi.fn(async () => runFindUnique ?? null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    knowledgeChatSession: {
      findUnique: vi.fn(async () => session),
      update: vi.fn(async () => ({})),
    },
  } as never as {
    knowledgeChatRun: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    knowledgeChatSession: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
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
    expect(tx.knowledgeChatSession.update.mock.calls[0][0].data.pendingSystemMessage).toBe('msg');
    // The proposal id travels back with its text, or the restored message loses what it refers to.
    expect(tx.knowledgeChatSession.update.mock.calls[0][0].data.pendingSystemMessageProposalId).toBe('p1');
  });

  it('drops the older message when a newer one already occupies the slot', async () => {
    const tx = txWith({ id: 's1', pendingSystemMessage: 'newer' }, consumedRun({ systemMessageText: 'old' }));
    await restoreOnPreSpawnFailure(tx as never, 'r1', 'boom');
    expect(tx.knowledgeChatRun.updateMany.mock.calls[0][0].data.systemMessageState).toBe('DROPPED');
    expect(tx.knowledgeChatSession.update).not.toHaveBeenCalled();
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
    expect(tx.knowledgeChatSession.update).toHaveBeenCalled();
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
