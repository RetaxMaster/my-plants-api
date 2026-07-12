import { describe, expect, it } from 'vitest';
import { KnowledgeChatOrchestrator } from './knowledge-chat-orchestrator.js';

type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
interface Run { id: string; sessionId: string; provider: string; providerSessionId?: string | null; sessionTracked?: boolean; commandName?: string | null; createdAt?: Date; status: Status; activeKey: string | null; pid: number | null; procStartTime: string | null; startedAt: Date | null; finishedAt: Date | null; exitCode: number | null; error: string | null }
interface Session { id: string; provider?: string; providerSessionId: string | null; pendingRunId?: string | null }

function makePrismaFake(runs: Run[], sessions: Session[]) {
  const runMap = new Map(runs.map((r) => [r.id, r]));
  const sessMap = new Map(sessions.map((s) => [s.id, s]));
  const matches = (r: Run, where: any) =>
    (where.id === undefined || r.id === where.id) &&
    (where.status?.in === undefined || where.status.in.includes(r.status)) &&
    (where.pid?.not === undefined || r.pid !== null) &&
    (where.procStartTime?.not === undefined || r.procStartTime !== null) &&
    (where.startedAt?.not === undefined || r.startedAt !== null) &&
    (where.status === undefined || typeof where.status === 'object' || r.status === where.status);
  return {
    runMap, sessMap,
    knowledgeChatRun: {
      findUnique: async ({ where }: any) => runMap.get(where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of runMap.values()) if (matches(r, where)) { Object.assign(r, data); count++; }
        return { count };
      },
      findFirst: async ({ where, orderBy }: any) => {
        const rows = [...runMap.values()].filter((r) => r.sessionId === where.sessionId);
        // newest-first by createdAt, falling back to insertion order
        rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        return rows[0] ?? null;
      },
      findMany: async ({ where, include }: any) => {
        const out = [...runMap.values()].filter((r) => matches(r, where));
        return include?.session ? out.map((r) => ({ ...r, session: sessMap.get(r.sessionId) })) : out;
      },
    },
    knowledgeChatSession: {
      update: async ({ where, data }: any) => { const s = sessMap.get(where.id) as any; if (s) Object.assign(s, data); return s; },
      findUnique: async ({ where, include }: any) => {
        const s = [...sessMap.values()].find((x: any) =>
          where.providerSessionId !== undefined ? x.providerSessionId === where.providerSessionId : x.id === where.id,
        ) as any;
        if (!s) return null;
        return include?.runs
          ? { ...s, runs: [...runMap.values()].filter((r) => r.sessionId === s.id) }
          : s;
      },
      updateMany: async ({ where, data }: any) => {
        const s = sessMap.get(where.id);
        if (!s) return { count: 0 };
        // Mirror the real WHERE clause exactly — including the seal claim, which is the whole point.
        if (where.providerSessionId === null && s.providerSessionId !== null) return { count: 0 };
        if (where.pendingRunId !== undefined && s.pendingRunId !== where.pendingRunId) return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      },
    },
  };
}

const env = { KNOWLEDGE_CHAT_LOG_DIR: '/logs' } as any;
const tickets = { consume: async (raw: string) => (raw === 'good' ? { runId: 'r1' } : null) } as any;

describe('KnowledgeChatOrchestrator.validateTicket', () => {
  it('delegates to the ticket store', async () => {
    const orch = new KnowledgeChatOrchestrator(makePrismaFake([], []) as any, tickets, env);
    expect(await orch.validateTicket('good')).toEqual({ runId: 'r1' });
    expect(await orch.validateTicket('bad')).toBeNull();
  });
});

describe('KnowledgeChatOrchestrator.runStarted', () => {
  it('first call stamps RUNNING + pid + startedAt; sets providerSessionId only when the agent session id arrives', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', provider: 'claude', status: 'QUEUED', activeKey: 'ACTIVE', pid: null, procStartTime: null, startedAt: null, finishedAt: null, exitCode: null, error: null };
    // The run holds the seal claim, exactly as insertActiveRun grants it in production.
    const session: Session = { id: 's1', providerSessionId: null, pendingRunId: 'r1' };
    const prisma = makePrismaFake([run], [session]);
    const orch = new KnowledgeChatOrchestrator(prisma as any, tickets, env);

    // First call (spawn): sessionId null → stamps startedAt, providerSessionId still null.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: null });
    expect(run.status).toBe('RUNNING');
    expect(run.pid).toBe(1234);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(session.providerSessionId).toBeNull();
    const firstStartedAt = run.startedAt;

    // Second call (the agent session id appears): stamps providerSessionId once; does NOT move startedAt.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: 'uuid-abc' });
    expect(session.providerSessionId).toBe('uuid-abc');
    expect(run.startedAt).toBe(firstStartedAt);

    // Third call with a different uuid must NOT clobber the captured one.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: 'uuid-xyz' });
    expect(session.providerSessionId).toBe('uuid-abc');
  });

  it('never resurrects a terminal run', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', provider: 'claude', status: 'CANCELLED', activeKey: null, pid: null, procStartTime: null, startedAt: null, finishedAt: new Date(), exitCode: null, error: null };
    const prisma = makePrismaFake([run], [{ id: 's1', providerSessionId: null }]);
    const orch = new KnowledgeChatOrchestrator(prisma as any, tickets, env);
    await orch.runStarted('r1', { pid: 1, procStartTime: '1', sessionId: null });
    expect(run.status).toBe('CANCELLED'); // untouched
  });
});

describe('KnowledgeChatOrchestrator.runFinished', () => {
  const mk = (status: Status = 'RUNNING'): Run => ({ id: 'r1', sessionId: 's1', provider: 'claude', status, activeKey: status === 'QUEUED' || status === 'RUNNING' ? 'ACTIVE' : null, pid: 42, procStartTime: '9', startedAt: new Date(), finishedAt: null, exitCode: null, error: null });

  it('stopped → CANCELLED and releases the active slot (activeKey null)', async () => {
    const run = mk(); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 130, stopped: true, stderrTail: null });
    expect(run.status).toBe('CANCELLED');
    expect(run.pid).toBeNull();
    expect(run.activeKey).toBeNull();
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it('exit 0 → SUCCEEDED', async () => {
    const run = mk(); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 0, stopped: false, stderrTail: null });
    expect(run.status).toBe('SUCCEEDED');
  });

  it('non-zero exit → FAILED with the stderr tail (capped)', async () => {
    const run = mk(); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 1, stopped: false, stderrTail: 'boom' });
    expect(run.status).toBe('FAILED');
    expect(run.error).toBe('boom');
  });

  it('FAILED with NO stderr → synthesizes an actionable diagnostic (not a bare error)', async () => {
    const run = mk(); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 1, stopped: false, stderrTail: null });
    expect(run.status).toBe('FAILED');
    // The diagnostic must name the likely cause + the knobs to check. Provider-neutral since 1.0.0:
    // either agent can be the one that failed to spawn, so BOTH bins are named.
    expect(run.error).toMatch(/spawn failure/);
    expect(run.error).toMatch(/CLAUDE_BIN \/ CODEX_BIN/);
    expect(run.error).toMatch(/KNOWLEDGE_CHAT_LOG_DIR/);
    expect(run.error).toMatch(/KNOWLEDGE_CHAT_STATE_DIR/);
  });

  it('FAILED with blank/whitespace stderr also gets the diagnostic (not an empty error)', async () => {
    const run = mk(); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 2, stopped: false, stderrTail: '   ' });
    expect(run.error).toMatch(/KNOWLEDGE_CHAT_LOG_DIR/);
  });

  it('is a single-winner: a second finalize of an already-terminal run is a no-op', async () => {
    const run = mk('SUCCEEDED'); const prisma = makePrismaFake([run], []);
    await new KnowledgeChatOrchestrator(prisma as any, tickets, env).runFinished('r1', { exitCode: 1, stopped: false, stderrTail: 'late' });
    expect(run.status).toBe('SUCCEEDED'); // not overwritten
    expect(run.error).toBeNull();
  });
});

describe('KnowledgeChatOrchestrator.activeRuns', () => {
  it('returns only RUNNING rows with identity, mapped to the ActiveRun shape', async () => {
    const runs: Run[] = [
      { id: 'r1', sessionId: 's1', provider: 'claude', status: 'RUNNING', activeKey: 'ACTIVE', pid: 100, procStartTime: '555', startedAt: new Date(1_000_000), finishedAt: null, exitCode: null, error: null },
      { id: 'r2', sessionId: 's2', provider: 'claude', status: 'QUEUED', activeKey: 'ACTIVE', pid: null, procStartTime: null, startedAt: null, finishedAt: null, exitCode: null, error: null },
      { id: 'r3', sessionId: 's3', provider: 'claude', status: 'SUCCEEDED', activeKey: null, pid: 7, procStartTime: '1', startedAt: new Date(), finishedAt: new Date(), exitCode: 0, error: null },
    ];
    const sessions: Session[] = [{ id: 's1', providerSessionId: 'uuid-1' }, { id: 's2', providerSessionId: null }, { id: 's3', providerSessionId: 'uuid-3' }];
    const orch = new KnowledgeChatOrchestrator(makePrismaFake(runs, sessions) as any, tickets, env);
    const active = await orch.activeRuns();
    expect(active).toEqual([
      { runId: 'r1', logPath: '/logs/r1.ndjson', pid: 100, procStartTime: '555', startedAtMs: 1_000_000, sessionId: 'uuid-1' },
    ]);
  });
});


// REGRESSION (agents-realtime 1.0.0). The own-run locator tells the engine which runs make up a
// conversation. Claiming a run the engine cannot resolve makes the history read fail OUTRIGHT — which is
// how every PRE-UPGRADE conversation started answering 500 on reopen: those runs live in our DB but never
// entered the engine's durable index (it did not exist before 1.0.0).
describe('KnowledgeChatOrchestrator.runsForSession (own-run locator)', () => {
  const sess = (over: any = {}) => ({ id: 's1', provider: 'claude', providerSessionId: 'uuid-1', ...over });
  const term = (id: string, ms: number, over: Partial<Run> = {}): Run => ({ id, sessionId: 's1', provider: 'claude', providerSessionId: 'uuid-1', sessionTracked: true, status: 'SUCCEEDED', activeKey: null, pid: null, procStartTime: null, startedAt: new Date(ms), finishedAt: new Date(), exitCode: 0, error: null, ...over });

  const orchWith = (runs: Run[], sessions: any[], resolvable: (id: string) => boolean) => {
    const orch = new KnowledgeChatOrchestrator(makePrismaFake(runs, sessions) as any, tickets, env);
    orch.setRunLogResolver({ resolveLogPath: (runId: string) => (resolvable(runId) ? `/logs/${runId}.ndjson` : null) });
    return orch;
  };

  it('returns terminal runs the engine can resolve, oldest first', async () => {
    const orch = orchWith([term('r1', 1000), term('r2', 2000)], [sess()], () => true);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([
      { runId: 'r1', startedAtMs: 1000 },
      { runId: 'r2', startedAtMs: 2000 },
    ]);
  });

  // ALL-OR-NOTHING. The package treats what we return as the COMPLETE set of our runs and rebuilds the
  // conversation from exactly those — it only falls back to the agent's native transcript when we claim
  // NOTHING. So a PARTIAL claim (old unresolvable runs + one new resolvable one) would silently rebuild the
  // conversation with only the new turn and the older ones missing, with no error anywhere. Claiming none
  // sends the whole thing down the native path, where every turn still exists.
  it('claims NOTHING when even ONE settled run is unresolvable — never a partial (silently truncated) history', async () => {
    const orch = orchWith([term('r1', 1000), term('r2', 2000)], [sess()], (id) => id === 'r2');
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([]);
  });

  it('claims NO runs for a fully pre-upgrade conversation, so it restores via the agent own transcript', async () => {
    const orch = orchWith([term('r1', 1000)], [sess()], () => false);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([]);
  });

  // An ACTIVE run is being streamed live over the socket (which replays its log from offset 0). Seeding it
  // as history too would render that turn twice — once truncated, once live.
  it('excludes the ACTIVE run — the socket owns the present, history owns the settled past', async () => {
    const active: Run = { id: 'r2', sessionId: 's1', provider: 'claude', providerSessionId: 'uuid-1', status: 'RUNNING', activeKey: 'ACTIVE', pid: 9, procStartTime: '1', startedAt: new Date(2000), finishedAt: null, exitCode: null, error: null };
    const orch = orchWith([term('r1', 1000), active], [sess()], () => true);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([{ runId: 'r1', startedAtMs: 1000 }]);
  });

  it('never answers for a session bound to a DIFFERENT agent', async () => {
    const orch = orchWith([term('r1', 1000)], [sess({ provider: 'codex' })], () => true);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([]);
  });
});


// REGRESSION (race). A conversation whose opening turn never reached an agent may be RETRIED on a DIFFERENT
// agent. If a late `session.started` from the superseded run were allowed to land, it would seal the
// conversation to the agent the user just abandoned — while another agent is live — leaving `provider` and
// `providerSessionId` describing two different agents: a row claiming Codex while holding a Claude memory.
describe('KnowledgeChatOrchestrator.runStarted — sealing the conversation to its agent', () => {
  it('seals provider AND providerSessionId together, from the run that actually produced them', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', provider: 'codex', status: 'RUNNING', activeKey: 'ACTIVE', pid: 1, procStartTime: '1', startedAt: new Date(), finishedAt: null, exitCode: null, error: null };
    const session: Session = { id: 's1', provider: 'claude', providerSessionId: null, pendingRunId: 'r1' };
    const orch = new KnowledgeChatOrchestrator(makePrismaFake([run], [session]) as any, tickets, env);
    await orch.runStarted('r1', { pid: 1, procStartTime: '1', sessionId: 'thread-9' });
    expect(session.providerSessionId).toBe('thread-9');
    expect(session.provider).toBe('codex'); // the pair can never cross
  });

  // THE RACE, precisely. The abandoned run reports its session id AFTER the retry claimed the conversation.
  // Nothing about "which run is newest" is consulted: the seal simply cannot match a run that no longer
  // holds the claim, so there is no window to lose.
  it('an ABANDONED run cannot seal a conversation the retry already claimed', async () => {
    const old: Run = { id: 'r1', sessionId: 's1', provider: 'claude', status: 'FAILED', activeKey: null, pid: null, procStartTime: null, startedAt: new Date(), finishedAt: new Date(), exitCode: 1, error: 'x' };
    const retry: Run = { id: 'r2', sessionId: 's1', provider: 'codex', status: 'RUNNING', activeKey: 'ACTIVE', pid: 2, procStartTime: '2', startedAt: new Date(), finishedAt: null, exitCode: null, error: null };
    const session: Session = { id: 's1', provider: 'codex', providerSessionId: null, pendingRunId: 'r2' }; // the retry holds the claim
    const orch = new KnowledgeChatOrchestrator(makePrismaFake([old, retry], [session]) as any, tickets, env);

    await orch.runStarted('r1', { pid: 1, procStartTime: '1', sessionId: 'claude-uuid' }); // late, abandoned
    expect(session.providerSessionId).toBeNull();  // it may NOT pin the conversation to the agent the user left
    expect(session.provider).toBe('codex');

    await orch.runStarted('r2', { pid: 2, procStartTime: '2', sessionId: 'codex-thread' }); // the live run seals
    expect(session.providerSessionId).toBe('codex-thread');
    expect(session.provider).toBe('codex');
  });
});


// A run can be ALIVE across a restart (re-adopted). If its conversation does not name it as the sealer —
// it was launched by the previous process, or created between migration 0015's backfill and the restart —
// its session id could never land, leaving the conversation permanently unsealed. Boot re-adoption is
// where we repair that; the single-active-run constraint makes the owner unambiguous.
describe('KnowledgeChatOrchestrator.activeRuns — repairing the seal claim across a restart', () => {
  it('restores pendingRunId for a live run whose conversation lost (or never had) the claim', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', provider: 'claude', status: 'RUNNING', activeKey: 'ACTIVE', pid: 100, procStartTime: '555', startedAt: new Date(1_000_000), finishedAt: null, exitCode: null, error: null };
    const session: Session = { id: 's1', providerSessionId: null, pendingRunId: null }; // spans the deploy
    const orch = new KnowledgeChatOrchestrator(makePrismaFake([run], [session]) as any, tickets, env);

    const active = await orch.activeRuns();
    expect(active).toHaveLength(1);
    expect(session.pendingRunId).toBe('r1'); // it can seal itself when its session id arrives

    // Proof it now actually CAN seal.
    await orch.runStarted('r1', { pid: 100, procStartTime: '555', sessionId: 'uuid-late' });
    expect(session.providerSessionId).toBe('uuid-late');
  });
});


// REGRESSION (BUG-1, found in live QA). Retrying an opening turn that never reached an agent leaves an
// ORPHANED run behind: its log contains no agent session at all. Claiming it as one of the conversation's
// runs made the engine fail the ENTIRE history read — so every reopen of that conversation 500'd and
// rendered a blank transcript, permanently. And this is reachable by ordinary use: hit Stop in the first
// second of a new chat, then send again.
//
// The orphan contributed NOTHING to the agent's memory, so excluding it loses nothing — and it must not
// drag the whole conversation onto the fallback path either.
describe('KnowledgeChatOrchestrator.runsForSession — orphaned runs from a retried opening turn', () => {
  const sess = (over: any = {}) => ({ id: 's1', provider: 'claude', providerSessionId: 'uuid-1', ...over });
  const orchWith = (runs: Run[], sessions: any[], resolvable: (id: string) => boolean) => {
    const orch = new KnowledgeChatOrchestrator(makePrismaFake(runs, sessions) as any, tickets, env);
    orch.setRunLogResolver({ resolveLogPath: (runId: string) => (resolvable(runId) ? `/logs/${runId}.ndjson` : null) });
    return orch;
  };
  const term = (id: string, ms: number, over: Partial<Run> = {}): Run => ({ id, sessionId: 's1', provider: 'claude', providerSessionId: 'uuid-1', sessionTracked: true, status: 'SUCCEEDED', activeKey: null, pid: null, procStartTime: null, startedAt: new Date(ms), finishedAt: new Date(), exitCode: 0, error: null, ...over });

  it('EXCLUDES an orphaned run (it never reached the agent) without poisoning the rest of the history', async () => {
    const orphan = term('r1', 1000, { status: 'CANCELLED', providerSessionId: null, exitCode: 130 });
    const retry = term('r2', 2000); // the retry that actually established the session
    const orch = orchWith([orphan, retry], [sess()], () => true);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([{ runId: 'r2', startedAtMs: 2000 }]);
  });

  // A REFUSED COMMAND (`/clear`) is refused by the engine BEFORE it spawns anything: no runner, no agent
  // session, no startedAt — but a real, completed run whose log carries the refusal and its reason. Every
  // other rule here misses it, and dropping it deleted the only place the answer to "why didn't /clear work?"
  // survives a reload. It is a member.
  it('INCLUDES a refused command (no agent session, no startedAt) — the refusal must survive a reload', async () => {
    const first = term('r1', 1000);
    const refused = term('r2', 0, {
      commandName: 'clear',
      providerSessionId: null,
      startedAt: null, // it never started; it was refused
      createdAt: new Date(1500),
    });
    const orch = orchWith([first, refused], [sess()], () => true);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([
      { runId: 'r1', startedAtMs: 1000 },
      { runId: 'r2', startedAtMs: 1500 }, // ordered by createdAt — it has no startedAt to order by
    ]);
  });

  // The discriminator must not swallow a LAUNCH FAILURE that happens to be a command: that run never got a
  // log at all (the engine never accepted it), so claiming it would hand the engine a runId it cannot
  // resolve and fail the whole history read.
  it('EXCLUDES a command run whose launch failed before the engine ever created its log', async () => {
    const first = term('r1', 1000);
    const neverLaunched = term('r2', 0, {
      commandName: 'compact',
      providerSessionId: null,
      startedAt: null,
      createdAt: new Date(1500),
      status: 'FAILED',
    });
    // r2 has no log in the durable index — that is exactly what makes it not a refusal.
    const orch = orchWith([first, neverLaunched], [sess()], (id) => id !== 'r2');
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([{ runId: 'r1', startedAtMs: 1000 }]);
  });

  it('EXCLUDES an orphan left by a CROSS-AGENT retry (its log is another agent entirely)', async () => {
    const orphan = term('r1', 1000, { provider: 'claude', status: 'FAILED', providerSessionId: null, exitCode: 1 });
    const retry = term('r2', 2000, { provider: 'codex', providerSessionId: 'thread-7' });
    const orch = orchWith([orphan, retry], [sess({ provider: 'codex', providerSessionId: 'thread-7' })], () => true);
    expect(await orch.runsForSession('codex', 'thread-7')).toEqual([{ runId: 'r2', startedAtMs: 2000 }]);
  });

  // A run that DID reach an agent but that we cannot serve (pre-1.0.0: absent from the durable index) is a
  // real turn we would be dropping — so the whole conversation goes to the native transcript instead.
  it('still claims NOTHING when a run that DID reach the agent is unservable (never a partial history)', async () => {
    const legacy = term('r1', 1000); // in the agent session, but its log is not in the engine index
    const fresh = term('r2', 2000);
    const orch = orchWith([legacy, fresh], [sess()], (id) => id === 'r2');
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([]);
  });
});


// REGRESSION (Codex review). A run from BEFORE we recorded the agent session also has providerSessionId
// NULL — but that null means "unknown", not "it never reached the agent". Reading it as an orphan would
// silently drop a real turn from a rebuilt conversation, with no error anywhere.
describe('KnowledgeChatOrchestrator.runsForSession — an UNTRACKED run is unknown, not an orphan', () => {
  const sess = (over: any = {}) => ({ id: 's1', provider: 'claude', providerSessionId: 'uuid-1', ...over });
  const orchWith = (runs: Run[], sessions: any[]) => {
    const orch = new KnowledgeChatOrchestrator(makePrismaFake(runs, sessions) as any, tickets, env);
    orch.setRunLogResolver({ resolveLogPath: (runId: string) => `/logs/${runId}.ndjson` }); // all resolvable
    return orch;
  };
  const run = (id: string, ms: number, over: Partial<Run>): Run => ({ id, sessionId: 's1', provider: 'claude', providerSessionId: 'uuid-1', sessionTracked: true, status: 'SUCCEEDED', activeKey: null, pid: null, procStartTime: null, startedAt: new Date(ms), finishedAt: new Date(), exitCode: 0, error: null, ...over });

  it('falls back to the native transcript rather than dropping an untracked turn', async () => {
    const legacy = run('r1', 1000, { sessionTracked: false, providerSessionId: null }); // may well have reached the agent
    const fresh = run('r2', 2000, {});
    const orch = orchWith([legacy, fresh], [sess()]);
    // Claiming only r2 would rebuild the conversation with r1's turn silently missing.
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([]);
  });

  it('a TRACKED run with no session is still a proven orphan and is simply excluded', async () => {
    const orphan = run('r1', 1000, { status: 'CANCELLED', providerSessionId: null, exitCode: 130 });
    const fresh = run('r2', 2000, {});
    const orch = orchWith([orphan, fresh], [sess()]);
    expect(await orch.runsForSession('claude', 'uuid-1')).toEqual([{ runId: 'r2', startedAtMs: 2000 }]);
  });
});
