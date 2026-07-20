import { describe, it, expect, vi } from 'vitest';
import { admitRun } from './knowledge-chat.service.js';
import { SYSTEM_MESSAGE } from './system-message.js';

function tx(over: Record<string, unknown> = {}) {
  return {
    doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 1 })) },
    knowledgeChatSession: {
      findUnique: vi.fn(async () => ({
        id: 's1',
        kind: 'DOCTOR',
        pendingSystemMessage: null,
        pendingSystemMessageProposalId: null,
      })),
      update: vi.fn(async () => ({})),
    },
    knowledgeChatRun: { create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'r2', ...a.data })) },
    ...over,
  } as never as {
    doctorWriteProposal: { updateMany: ReturnType<typeof vi.fn> };
    knowledgeChatSession: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    knowledgeChatRun: { create: ReturnType<typeof vi.fn> };
  };
}

const queued = (text: string, proposalId: string | null = null) => ({
  knowledgeChatSession: {
    findUnique: vi.fn(async () => ({
      id: 's1',
      kind: 'DOCTOR',
      pendingSystemMessage: text,
      pendingSystemMessageProposalId: proposalId,
    })),
    update: vi.fn(async () => ({})),
  },
});

describe('admitRun', () => {
  it('expires the pending proposal and queues the not-approved nudge in its OWN column', async () => {
    const t = tx();
    const run = await admitRun(t as never, {
      sessionId: 's1',
      provider: 'claude',
      input: { prompt: 'why is it yellow?' },
    });
    expect(t.doctorWriteProposal.updateMany.mock.calls[0][0].where).toMatchObject({
      sessionId: 's1',
      status: 'PENDING',
    });
    // The nudge no longer touches `prompt` (spec 3.1) — it rides systemMessageText and, on the wire, the
    // package's out-of-band `systemMessage` field.
    expect(run.prompt).toBe('why is it yellow?');
    expect(run.systemMessageState).toBe('CONSUMED');
    expect(run.systemMessageText).toBe(SYSTEM_MESSAGE.notApproved);
  });

  it('leaves the queued message untouched on a COMMAND turn and does not prefix it', async () => {
    const t = tx(queued(SYSTEM_MESSAGE.declined, 'prop-1'));
    const run = await admitRun(t as never, {
      sessionId: 's1',
      provider: 'claude',
      input: { command: { name: 'compact', args: '' } },
    });
    expect(run.prompt).toBeNull();
    expect(run.commandName).toBe('compact');
    expect(run.systemMessageState).toBeNull();
    // steps 1-2 still ran (the proposal is expired); only consume+prefix is skipped
    expect(t.doctorWriteProposal.updateMany).toHaveBeenCalled();
  });

  it('does not queue a nudge when there was no pending proposal to expire', async () => {
    const t = tx({ doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) } });
    const run = await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: 'hola' } });
    expect(run.prompt).toBe('hola');
    expect(run.systemMessageState).toBeNull();
  });

  it('replaces an older queued message with a newer one', async () => {
    const t = tx(queued(SYSTEM_MESSAGE.declined, 'prop-0'));
    const run = await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: 'hi' } });
    // the expiry queued notApproved, which replaces the older declined
    expect(run.systemMessageText).toBe(SYSTEM_MESSAGE.notApproved);
    // ...and the superseded proposal id goes with it, or the run would carry a message about ONE
    // proposal tagged with the id of ANOTHER.
    expect(run.systemMessageProposalId).toBeNull();
  });

  it('delivers a queued message that no expiry replaced, carrying its proposal id', async () => {
    const t = tx({
      ...queued(SYSTEM_MESSAGE.declined, 'prop-7'),
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });
    const run = await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: 'hi' } });
    expect(run.prompt).toBe('hi');
    expect(run.systemMessageText).toBe(SYSTEM_MESSAGE.declined);
    expect(run.systemMessageProposalId).toBe('prop-7');
    expect(run.systemMessageState).toBe('CONSUMED');
  });

  it('consumes the message off the session in the SAME transaction that inserts the run', async () => {
    // At-most-once (spec 5.5.4): if consuming and inserting could be split, a crash between them would
    // either duplicate the message or lose it.
    const t = tx({
      ...queued(SYSTEM_MESSAGE.declined, 'prop-7'),
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });
    await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: 'hi' } });
    const clearing = t.knowledgeChatSession.update.mock.calls.find(
      (c) => c[0].data.pendingSystemMessage === null,
    );
    expect(clearing).toBeDefined();
    expect(clearing![0].data.pendingSystemMessageProposalId).toBeNull();
  });

  it('stores a NULL prompt when the turn has an empty prompt (the decline-triggered turn)', async () => {
    // `startQueuedSystemTurn` admits a turn whose entire content IS the queued message, passing prompt:''.
    // The empty string was a sentinel that looked like data — the agent received it as a blank turn. NULL
    // is what "the user typed nothing" actually means, and 3.0.0 accepts it on the wire.
    const t = tx({
      ...queued(SYSTEM_MESSAGE.declined, 'prop-7'),
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });
    const run = await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: '' } });
    expect(run.prompt).toBeNull();
    expect(run.systemMessageText).toBe(SYSTEM_MESSAGE.declined);
  });

  it('sets activeKey so the DB enforces one active run per session', async () => {
    const t = tx();
    const run = await admitRun(t as never, { sessionId: 's1', provider: 'claude', input: { prompt: 'hi' } });
    expect(run.activeKey).toBe('ACTIVE');
    expect(run.status).toBe('QUEUED');
  });

  it('stores commandArgs as the RAW argument string, never JSON-encoded', async () => {
    // The column holds the args verbatim (`getSession` renders `commandArgs ?? ''` straight back onto the
    // wire). Serializing here would double-encode every command turn — `--model opus` would reach the
    // agent as `"--model opus"`, quotes included.
    const t = tx();
    const run = await admitRun(t as never, {
      sessionId: 's1',
      provider: 'claude',
      input: { command: { name: 'model', args: '--model opus' } },
    });
    expect(run.commandArgs).toBe('--model opus');
  });
});

describe('admitRun prompt composition (3.0.x transport)', () => {
  it('persists the user text ALONE and the system message in its own column', async () => {
    // No proposal expires here, so the session's own queued message is the one consumed.
    const t = tx({
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
      ...queued(SYSTEM_MESSAGE.declined, 'p1'),
    });
    const run = await admitRun(t as never, {
      sessionId: 's1',
      provider: 'claude',
      input: { prompt: 'How is my fern?' },
    });

    expect(run.prompt).toBe('How is my fern?');
    expect(run.systemMessageText).toBe(SYSTEM_MESSAGE.declined);
    expect(run.systemMessageState).toBe('CONSUMED');
  });

  it('is byte-identical to the old behaviour when no message is queued (the compatibility anchor)', async () => {
    const t = tx({
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
      ...queued(null as never),
    });
    const run = await admitRun(t as never, {
      sessionId: 's1',
      provider: 'claude',
      input: { prompt: 'How is my fern?' },
    });

    expect(run.prompt).toBe('How is my fern?');
    expect(run.systemMessageText).toBeNull();
    expect(run.systemMessageState).toBeNull();
  });
});
