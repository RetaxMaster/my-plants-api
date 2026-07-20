import { describe, expect, it, vi } from 'vitest';
import { SessionNotFoundError } from '@retaxmaster/agents-realtime-server';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OwnerService } from '../owner/owner.service.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';

type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
// NOTE: `activeKey` mirrors the DB column — 'ACTIVE' on a non-terminal run, null once terminal; the
// fake enforces the @@unique([sessionId, activeKey]) constraint on create (null is exempt).
interface Run { id: string; sessionId: string; provider: string; prompt: string; status: Status; activeKey: string | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date; error: string | null; pid: number | null; procStartTime: string | null; exitCode: number | null }
interface Session { id: string; provider: string; providerSessionId: string | null; pendingRunId?: string | null; title: string; createdByUserId: string | null; createdAt: Date; updatedAt: Date }

const actor = (userId = 'admin-user') => ({ userId, username: 'root', ownerId: 'o', role: 'ADMIN' as const, jti: 'j', exp: 9e9 });
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

function setup(seed: { sessions?: Session[]; runs?: Run[]; proposals?: any[] } = {}) {
  let seq = 0;
  // Offset generated ids well past any seeded id (seeds use r1/r2/s1) so a freshly created run/session
  // never overwrites a seeded row in the in-memory map.
  const nextId = (p: string) => `${p}${1000 + ++seq}`;
  // Default kind/plantId/ownerId in-place (migration 0021 defaults; tests mostly seed KNOWLEDGE sessions).
  const sessions = new Map((seed.sessions ?? []).map((s) => {
    const x = s as any;
    x.kind ??= 'KNOWLEDGE';
    x.plantId ??= null;
    x.ownerId ??= null;
    return [s.id, s];
  }));
  const runs = new Map((seed.runs ?? []).map((r) => [r.id, r]));
  const proposals = new Map<string, any>((seed.proposals ?? []).map((p) => [p.id, { ...p }]));
  // Serializes $transaction calls so a rollback can never touch another transaction's committed writes.
  let txChain: Promise<void> = Promise.resolve();

  // Attach a session's runs the way Prisma's `include: { runs: { orderBy } }` would, so the service
  // code (which reads session.runs) exercises the real path against the fake.
  const withRuns = (s: Session | undefined, include: any) => {
    if (!s) return s ?? null;
    if (!include?.runs) return s;
    const dir = include.runs?.orderBy?.createdAt === 'asc' ? 1 : -1;
    const attached = [...runs.values()]
      .filter((r) => r.sessionId === s.id)
      .sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
    return { ...s, runs: attached };
  };
  const db = {
    knowledgeChatSession: {
      create: async ({ data }: any) => { const s: Session = { id: nextId('s'), provider: 'claude', providerSessionId: null, createdAt: new Date(), updatedAt: new Date(), createdByUserId: null, ...data }; sessions.set(s.id, s); return s; },
      findUnique: async ({ where, include }: any) => withRuns(sessions.get(where.id), include),
      update: async ({ where, data }: any) => { const s = sessions.get(where.id)!; Object.assign(s, data); return s; },
      updateMany: async ({ where, data }: any) => {
        const s = sessions.get(where.id);
        // Mirrors the real guard: the write only lands while the conversation still has no agent session.
        if (!s || (where.providerSessionId === null && s.providerSessionId !== null)) return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      },
      findMany: async ({ where, include }: any = {}) => [...sessions.values()]
        .filter((s: any) => (where == null) || Object.entries(where).every(([k, v]) => s[k] === v))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((s) => withRuns(s, include)),
      delete: async ({ where }: any) => { const s = sessions.get(where.id); sessions.delete(where.id); for (const [k, r] of runs) if (r.sessionId === where.id) runs.delete(k); return s; },
    },
    knowledgeChatRun: {
      // Enforce the composite unique constraint: at most ONE active (activeKey==='ACTIVE') run per
      // session. The check+set is synchronous within this call (no await between) — so two racing
      // creates cannot both win: the second sees the first's ACTIVE row and throws P2002.
      create: async ({ data }: any) => {
        if (data.activeKey === 'ACTIVE') {
          for (const r of runs.values()) if (r.sessionId === data.sessionId && r.activeKey === 'ACTIVE') throw uniqueViolation();
        }
        const r: Run = { id: nextId('r'), status: 'QUEUED', activeKey: null, startedAt: null, finishedAt: null, createdAt: new Date(), error: null, pid: null, procStartTime: null, exitCode: null, ...data };
        runs.set(r.id, r); return r;
      },
      findUnique: async ({ where, include }: any) => {
        const r = runs.get(where.id) ?? null;
        if (r && include?.session) return { ...r, session: sessions.get(r.sessionId) };
        return r;
      },
      findMany: async ({ where }: any) => [...runs.values()].filter((r) => (where?.sessionId ? r.sessionId === where.sessionId : true) && (where?.activeKey !== undefined ? r.activeKey === where.activeKey : true)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      update: async ({ where, data }: any) => { const r = runs.get(where.id); if (!r) throw new Error(`run not found: ${where.id}`); Object.assign(r, data); return r; },
      updateMany: async ({ where, data }: any) => { let count = 0; for (const r of runs.values()) { const active = where.status?.in ? where.status.in.includes(r.status) : true; if ((where.id ? r.id === where.id : where.sessionId ? r.sessionId === where.sessionId : true) && active) { Object.assign(r, data); count++; } } return { count }; },
    },
    // Run admission now expires the session's PENDING proposal in the SAME transaction (spec 5.5.4), so
    // the fake carries the table. It is a REAL in-memory implementation, not an empty stub: the tests
    // below assert that admitting a turn actually expires a pending proposal and queues the nudge, which
    // a `() => ({ count: 0 })` stub would silently make unprovable.
    doctorWriteProposal: {
      create: async ({ data }: any) => { const p = { id: nextId('prop'), ...data }; proposals.set(p.id, p); return p; },
      findMany: async ({ where }: any = {}) => [...proposals.values()].filter((p: any) => (where?.sessionId ? p.sessionId === where.sessionId : true) && (where?.status ? p.status === where.status : true)),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const p of proposals.values() as any) {
          if ((where.sessionId ? p.sessionId === where.sessionId : true) && (where.id ? p.id === where.id : true) && (where.status ? p.status === where.status : true)) { Object.assign(p, data); count++; }
        }
        return { count };
      },
    },
    // User.ownerId is @unique: resolve THE user of an owner (the doctor token's subject, Spec 3 §3.3).
    user: {
      findUnique: async ({ where }: any) => ({ id: `u-${where.ownerId}`, username: `user-${where.ownerId}`, ownerId: where.ownerId }),
    },
    // A REAL transaction, including ROLLBACK. It is not enough to "run the callback": the ordered
    // admission (spec 5.5.4) rests entirely on expire + consume + insert sharing one atomic unit, so a
    // fake that never rolls back cannot tell a correct implementation from one that does not share a
    // transaction at all — and it reports a FALSE FAILURE for the case that matters most (a run losing
    // the activeKey race must NOT have consumed the session's queued message).
    // The maps hold flat row objects, so a shallow clone per row is a faithful snapshot.
    // SERIALIZED, because rollback and isolation are inseparable. With a shared in-memory store, two
    // interleaved transactions would let one's rollback erase the other's already-committed writes — which
    // is precisely what broke the concurrent-resume test: the loser's P2002 rollback deleted the winner's
    // run. A real DB isolates them (and its row locks serialize these conflicting writes anyway), so the
    // fake runs them one at a time through a promise chain.
    $transaction: async (fn: any) => {
      const result = txChain.then(async () => {
        const snapshot = [sessions, runs, proposals].map((m) => new Map([...m].map(([k, v]) => [k, { ...(v as object) }])));
        try {
          return await fn(db);
        } catch (err) {
          [sessions, runs, proposals].forEach((m, i) => { m.clear(); for (const [k, v] of snapshot[i]!) m.set(k, v as never); });
          throw err;
        }
      });
      // The chain must not break on a rejected transaction, or every later one inherits the failure.
      txChain = result.then(() => undefined, () => undefined);
      return result;
    },
  } as any;

  const engine = { execute: vi.fn(async () => {}), loadHistory: vi.fn(async () => ({ provider: 'claude', providerSessionId: 'uuid-1', turns: [] })) };
  const tickets = { mint: vi.fn(async (_runId: string) => 'raw-ticket') };
  const logDir = mkdtempSync(join(tmpdir(), 'kchat-'));
  const env = { KNOWLEDGE_CHAT_LOG_DIR: logDir, KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000, KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000 } as any;
  // The registry hands the shared service the right engine + log dir per kind; here both kinds resolve to the
  // one fake engine and the temp log dir (the KNOWLEDGE tests exercise the KNOWLEDGE path).
  const engines = { engineFor: () => engine, logDirFor: () => logDir } as any;
  const doctorRunContext = { prepareRun: vi.fn(async () => ({ workspaceDir: '/ws' })), sweep: vi.fn(async () => {}) } as any;
  const codexVerification = { isVerified: vi.fn(async () => true) } as any; // codex allowed unless a test flips it

  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new KnowledgeChatService(db, engines, tickets as any, owner, doctorRunContext, codexVerification, env);
  const run = <T>(fn: () => Promise<T>, a = actor()) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, engine, tickets, sessions, runs, proposals, logDir, doctorRunContext, codexVerification };
}

// The scope the admin KE controller passes; the existing tests all exercise the KNOWLEDGE surface.
const KS = { kind: 'KNOWLEDGE' } as const;

// Seed helpers — an ACTIVE run carries activeKey 'ACTIVE'; a terminal run carries null.
const activeRun = (over: Partial<Run> = {}): Run => ({ id: 'r1', sessionId: 's1', provider: 'claude', prompt: 'p', status: 'RUNNING', activeKey: 'ACTIVE', startedAt: new Date(), finishedAt: null, createdAt: new Date(), error: null, pid: 10, procStartTime: '1', exitCode: null, ...over });
const doneRun = (over: Partial<Run> = {}): Run => ({ id: 'r1', sessionId: 's1', provider: 'claude', prompt: 'p', status: 'SUCCEEDED', activeKey: null, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(), error: null, pid: null, procStartTime: null, exitCode: 0, ...over });
const session = (over: Partial<Session> = {}): Session => ({ id: 's1', provider: 'claude', providerSessionId: 'uuid-1', title: 't', createdByUserId: null, createdAt: new Date(), updatedAt: new Date(), ...over });

describe('KnowledgeChatService.createSession', () => {
  it('creates a session + first (active) run on the CHOSEN agent, mints a ticket, and calls /execute', async () => {
    const { svc, run, engine, tickets, sessions, runs, logDir } = setup();
    const out = await run(() => svc.createSession('Research Monstera deliciosa care', 'codex', KS));
    expect(sessions.get(out.sessionId)?.pendingRunId).toBe(out.runId); // the run that may seal it
    expect(out.ticket).toBe('raw-ticket');
    expect(sessions.get(out.sessionId)?.title).toBe('Research Monstera deliciosa care');
    expect(sessions.get(out.sessionId)?.createdByUserId).toBe('admin-user');
    expect(sessions.get(out.sessionId)?.provider).toBe('codex'); // the conversation remembers its agent
    expect(runs.get(out.runId)?.activeKey).toBe('ACTIVE'); // holds the unique slot
    expect(tickets.mint).toHaveBeenCalledWith(out.runId);
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId, provider: 'codex', resumeSessionId: null, logPath: join(logDir, `${out.runId}.ndjson`) }));
  });

  // REGRESSION GUARD (agents-realtime 1.0.0). The engine creates the run log itself, exclusively
  // (O_CREAT|O_EXCL), and rejects a logPath that already exists — that exclusivity is what stops two runs
  // from sharing one log. The host used to pre-create/truncate the file here; doing so now makes the
  // engine reject EVERY run with a 422. So: the file must NOT exist when we call /execute.
  it('does NOT pre-create the run log — the engine owns it (O_EXCL); a pre-created file would 422 the run', async () => {
    const { svc, run, logDir } = setup();
    const out = await run(() => svc.createSession('hi', 'claude', KS));
    expect(existsSync(join(logDir, `${out.runId}.ndjson`))).toBe(false);
  });

  it('truncates the title to ~160 chars', async () => {
    const { svc, run, sessions } = setup();
    const long = 'x'.repeat(500);
    const out = await run(() => svc.createSession(long, 'claude', KS));
    expect(sessions.get(out.sessionId)!.title.length).toBe(160);
  });

  it('marks the run FAILED (activeKey cleared) and rethrows when /execute fails (never leaves it QUEUED)', async () => {
    const { svc, run, engine, runs } = setup();
    engine.execute.mockRejectedValueOnce(new Error('engine down'));
    await expect(run(() => svc.createSession('boom', 'claude', KS))).rejects.toThrow();
    const r = [...runs.values()][0];
    expect(r.status).toBe('FAILED');
    expect(r.activeKey).toBeNull(); // slot freed so the session isn't permanently blocked
  });

  it('also frees the slot when a PRE-/execute step fails (e.g. ticket mint throws) — never stuck QUEUED', async () => {
    const { svc, run, tickets, engine, runs } = setup();
    tickets.mint.mockRejectedValueOnce(new Error('mint failed'));
    await expect(run(() => svc.createSession('boom', 'claude', KS))).rejects.toThrow();
    const r = [...runs.values()][0];
    expect(r.status).toBe('FAILED');
    expect(r.activeKey).toBeNull();
    expect(engine.execute).not.toHaveBeenCalled(); // failed before ever reaching /execute
  });
});

describe('KnowledgeChatService.resume', () => {
  const seedResumable = () => ({ sessions: [session({ createdByUserId: 'admin-user' })], runs: [doneRun({ prompt: 'first' })] });

  it('adds a run and calls /execute with resumeSessionId = providerSessionId', async () => {
    const { svc, run, engine } = setup(seedResumable());
    const out = await run(() => svc.resume('s1', { prompt: 'follow-up question' }, undefined, KS));
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId, resumeSessionId: 'uuid-1' }));
  });

  // REGRESSION: this USED to 422 forever, which trapped the conversation on an agent that never ran — the
  // user's only escape was deleting it. A conversation with no agent session has no memory to protect, so
  // its opening turn is simply retried.
  it('retries the OPENING turn when no agent session was ever established (never a permanent 422)', async () => {
    const { svc, run, engine } = setup({
      sessions: [session({ providerSessionId: null })],
      runs: [doneRun({ status: 'FAILED', exitCode: 1, error: 'agent was signed out' })],
    });
    const out = await run(() => svc.resume('s1', { prompt: 'try again' }, undefined, KS));
    // A retry, not a resume: there is no agent session to resume FROM.
    expect(engine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ runId: out.runId, provider: 'claude', resumeSessionId: null }),
    );
  });

  it('lets the retry switch AGENTS, and records the agent that actually ran', async () => {
    const { svc, run, engine, sessions: rows } = setup({
      sessions: [session({ providerSessionId: null })], // originally created on claude
      runs: [doneRun({ status: 'FAILED', exitCode: 1, error: 'claude was signed out' })],
    });
    await run(() => svc.resume('s1', { prompt: 'try codex instead' }, 'codex', KS));
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', resumeSessionId: null }));
    expect(rows.get('s1')?.provider).toBe('codex'); // the row names the agent that actually ran
  });

  // Once a real agent session exists the conversation is FINAL: a client cannot hand a Claude memory to Codex.
  it('IGNORES a provider on resume once an agent session exists (the conversation owns its agent)', async () => {
    const { svc, run, engine } = setup(seedResumable());
    await run(() => svc.resume('s1', { prompt: 'next' }, 'codex', KS));
    expect(engine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude', resumeSessionId: 'uuid-1' }),
    );
  });
});

describe('single-active-run guard (DB-enforced, atomic)', () => {
  it('409 when a genuinely live (recent) run is active — the unique insert is rejected', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [activeRun()] });
    await expect(run(() => svc.resume('s1', { prompt: 'x' }, undefined, KS))).rejects.toBeInstanceOf(ConflictException);
  });

  it('reconciles a STALE active run to FAILED (activeKey cleared), then proceeds', async () => {
    const old = new Date(Date.now() - 3 * 3_600_000); // 3h ago, past timeout+buffer
    const { svc, run, engine, runs } = setup({ sessions: [session({ createdAt: old, updatedAt: old })], runs: [activeRun({ startedAt: old, createdAt: old })] });
    const out = await run(() => svc.resume('s1', { prompt: 'x' }, undefined, KS));
    expect(runs.get('r1')!.status).toBe('FAILED'); // reconciled
    expect(runs.get('r1')!.activeKey).toBeNull(); // slot freed
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId }));
  });

  it('two concurrent starts on one session → exactly one succeeds, the other gets 409', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [doneRun()] });
    const results = await run(() => Promise.allSettled([svc.resume('s1', { prompt: 'a' }, undefined, KS), svc.resume('s1', { prompt: 'b' }, undefined, KS)]));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
  });
});

describe('KnowledgeChatService.deleteSession', () => {
  it('409 when a run is active', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [activeRun()] });
    await expect(run(() => svc.deleteSession('s1', KS))).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes the session + its NDJSON logs when idle', async () => {
    const { svc, run, sessions, logDir } = setup({ sessions: [session()], runs: [doneRun()] });
    writeFileSync(join(logDir, 'r1.ndjson'), 'line');
    await run(() => svc.deleteSession('s1', KS));
    expect(sessions.has('s1')).toBe(false);
    expect(existsSync(join(logDir, 'r1.ndjson'))).toBe(false);
  });
});

describe('KnowledgeChatService.getRunLog', () => {
  it('returns the raw file contents', async () => {
    const { svc, run, logDir } = setup({ sessions: [session()], runs: [doneRun()] });
    writeFileSync(join(logDir, 'r1.ndjson'), '{"a":1}\n{"b":2}');
    expect(await run(() => svc.getRunLog('r1', KS))).toBe('{"a":1}\n{"b":2}');
  });

  it('404 when the file is gone', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [doneRun()] });
    await expect(run(() => svc.getRunLog('r1', KS))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the run\'s session is OUT of scope (a KNOWLEDGE surface never reads a DOCTOR transcript)', async () => {
    const { svc, run, logDir } = setup({
      sessions: [session({ id: 's1', kind: 'DOCTOR', plantId: 'A', ownerId: 'O' } as any)],
      runs: [doneRun()],
    });
    writeFileSync(join(logDir, 'r1.ndjson'), 'secret');
    // The KNOWLEDGE scope must not reach a DOCTOR run's log; a doctor scope for another plant must not either.
    await expect(run(() => svc.getRunLog('r1', KS))).rejects.toBeInstanceOf(NotFoundException);
    await expect(run(() => svc.getRunLog('r1', { kind: 'DOCTOR', plantId: 'B', ownerId: 'O' }))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeChatService list/detail', () => {
  it('lists sessions newest-first with latest-run status + turns count', async () => {
    const { svc, run } = setup({
      sessions: [session({ title: 'A', createdAt: new Date(1000) })],
      runs: [doneRun({ id: 'r1', createdAt: new Date(1000), startedAt: new Date(1000) }), activeRun({ id: 'r2', prompt: 'p2', startedAt: new Date(2000), createdAt: new Date(2000), pid: 1 })],
    });
    const list = await run(() => svc.listSessions(KS));
    expect(list[0]).toEqual(expect.objectContaining({ id: 's1', provider: 'claude', providerSessionId: 'uuid-1', title: 'A', status: 'RUNNING', turns: 2 }));
  });

  it('detail maps ordered turns with isActive + logUrl', async () => {
    const { svc, run } = setup({ sessions: [session({ title: 'A' })], runs: [activeRun({ prompt: 'p1', pid: 1 })] });
    const detail = await run(() => svc.getSession('s1', KS));
    expect(detail.providerSessionId).toBe('uuid-1');
    expect(detail.provider).toBe('claude');
    expect(detail.turns[0]).toEqual({ runId: 'r1', prompt: 'p1', command: null, status: 'RUNNING', isActive: true, logUrl: '/knowledge-chat/runs/r1/log' });
  });
});


// REGRESSION (agents-realtime 1.0.0). Reopening a PRE-UPGRADE conversation threw OwnRunLogUnavailableError
// out of the engine → an unhandled 500, an empty screen, AND a "can't be continued" message the database
// flatly contradicted. A transcript we cannot READ is not a conversation that is BROKEN: the agent still
// holds the session, so it is still resumable — only our view of the past is missing.
describe('KnowledgeChatService.getSessionHistory', () => {
  it('returns the engine canonical history for a readable conversation', async () => {
    const { svc, run, engine } = setup({ sessions: [session()], runs: [doneRun()] });
    const history = await run(() => svc.getSessionHistory('s1', KS));
    expect(engine.loadHistory).toHaveBeenCalledWith('claude', 'uuid-1');
    expect(history.providerSessionId).toBe('uuid-1');
  });

  // The agent itself no longer holds the session: the transcript is gone AND the conversation cannot be
  // continued (a resume would hand the agent a session id it rejects). We report BOTH facts, so the UI can
  // say so plainly instead of inviting a message that is guaranteed to fail.
  it('degrades a transcript that is genuinely GONE — never a 500 — and flags it as un-continuable', async () => {
    const { svc, run, engine } = setup({ sessions: [session()], runs: [doneRun()] });
    engine.loadHistory.mockRejectedValueOnce(new SessionNotFoundError('gone'));
    const history = await run(() => svc.getSessionHistory('s1', KS));
    expect(history).toEqual({
      provider: 'claude',
      providerSessionId: 'uuid-1',
      turns: [],
      agentSessionMissing: true,
    });
  });

  // A broken engine is NOT "your old chat is empty". Dressing an outage up as lost history is how a real
  // defect hides in plain sight, so anything that is not a typed "it's gone" stays LOUD.
  it('rethrows a REAL engine failure instead of disguising it as an empty transcript', async () => {
    const { svc, run, engine } = setup({ sessions: [session()], runs: [doneRun()] });
    engine.loadHistory.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(run(() => svc.getSessionHistory('s1', KS))).rejects.toThrow(/EACCES/);
  });

  it('422 for a conversation whose first run never opened an agent session (no history will ever exist)', async () => {
    const { svc, run } = setup({ sessions: [session({ providerSessionId: null })], runs: [doneRun({ status: 'FAILED' })] });
    await expect(run(() => svc.getSessionHistory('s1', KS))).rejects.toMatchObject({ status: 422 });
  });

  it('404 for an unknown conversation', async () => {
    const { svc, run } = setup();
    await expect(run(() => svc.getSessionHistory('nope', KS))).rejects.toMatchObject({ status: 404 });
  });
});


// REGRESSION (race). A retry reads "no agent session", but the ORIGINAL run may establish one in the gap
// before the retry writes. Re-pointing the conversation at another agent then would strand a real memory
// with an agent that cannot read a word of it. The conditional write is the guard: it matches zero rows,
// and the call degrades into the ordinary resume it has become.
describe('KnowledgeChatService.resume — the retry race', () => {
  it('does NOT switch agents when a session appears between the read and the write', async () => {
    const { svc, run, engine, sessions: rows } = setup({
      sessions: [session({ providerSessionId: null })],
      runs: [doneRun({ status: 'FAILED', exitCode: 1, error: 'x' })],
    });
    // The original Claude run wins the race and seals the conversation just as the user retries on Codex.
    rows.get('s1')!.providerSessionId = 'uuid-late';
    await run(() => svc.resume('s1', { prompt: 'retry on codex' }, 'codex', KS));
    // It must CONTINUE the Claude session that now exists — not launch Codex against a memory it cannot read.
    expect(engine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude', resumeSessionId: 'uuid-late' }),
    );
    expect(rows.get('s1')?.provider).toBe('claude');
  });
});

// A turn is a prompt XOR a command, all the way to /execute (agents-realtime 2.0.0's system commands). A
// command is a control instruction to the agent's RUNTIME, never text for the model — so it must never be
// representable as a `prompt` string at any hop we own.
describe('KnowledgeChatService.resume — commands (prompt XOR command)', () => {
  it('sends a COMMAND to /execute — never as a prompt', async () => {
    // A sealed conversation (it has an agent session), which is the only place a command is allowed.
    const { svc, run, engine, runs } = setup({
      sessions: [session({ providerSessionId: 'claude-uuid-1' })],
      runs: [doneRun()],
    });

    const out = await run(() => svc.resume('s1', { command: { name: 'compact', args: '' } }, undefined, KS));

    const sent = (engine.execute as any).mock.calls[0][0];
    expect(sent.command).toEqual({ name: 'compact', args: '' });
    expect(sent.prompt).toBeUndefined(); // the whole point: mutually exclusive at every hop
    const created = runs.get(out.runId)!;
    expect(created.prompt).toBeNull();
    expect((created as any).commandName).toBe('compact');
    expect((created as any).commandArgs).toBe('');
  });

  it('REFUSES a command on a conversation that has no agent session yet', async () => {
    // No providerSessionId → its opening turn never reached an agent. There is nothing to compact, nothing
    // to switch the model of, and no session for the command to act on.
    const { svc, run, engine } = setup({
      sessions: [session({ providerSessionId: null })],
      runs: [doneRun({ status: 'FAILED', exitCode: 1, error: 'x' })],
    });

    await expect(run(() => svc.resume('s1', { command: { name: 'compact', args: '' } }, undefined, KS)))
      .rejects.toThrow(UnprocessableEntityException);
    expect(engine.execute).not.toHaveBeenCalled();
  });
});


// Plant Doctor scope (Spec 3 §3.2/§3.3): ONE shared service serves both surfaces via a SessionScope. A
// doctor caller passes (kind=DOCTOR, plantId, ownerId); a KE caller passes (kind=KNOWLEDGE). The tuple is
// the access boundary — a session from another plant/owner is indistinguishable from "not found".
const DS = { kind: 'DOCTOR', plantId: 'A', ownerId: 'O' } as const;

describe('KnowledgeChatService — DOCTOR scope', () => {
  it('listSessions returns ONLY that scope — KE never sees DOCTOR and vice-versa', async () => {
    const { svc, run } = setup({
      sessions: [
        session({ id: 'ske', kind: 'KNOWLEDGE' } as any),
        session({ id: 'sdoc', kind: 'DOCTOR', plantId: 'A', ownerId: 'O' } as any),
      ],
    });
    expect((await run(() => svc.listSessions(KS))).map((s: any) => s.id)).toEqual(['ske']);
    const docList = await run(() => svc.listSessions(DS));
    expect(docList.map((s: any) => s.id)).toEqual(['sdoc']);
    expect(docList[0]).toEqual(expect.objectContaining({ kind: 'DOCTOR', plantId: 'A' }));
  });

  it('getSession 404s a DOCTOR session id from another plant or another owner', async () => {
    const { svc, run } = setup({ sessions: [session({ id: 'sdoc', kind: 'DOCTOR', plantId: 'A', ownerId: 'O' } as any)] });
    await expect(run(() => svc.getSession('sdoc', { kind: 'DOCTOR', plantId: 'B', ownerId: 'O' }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(run(() => svc.getSession('sdoc', { kind: 'DOCTOR', plantId: 'A', ownerId: 'OTHER' }))).rejects.toBeInstanceOf(NotFoundException);
    // A KNOWLEDGE scope must not reach a DOCTOR row either.
    await expect(run(() => svc.getSession('sdoc', KS))).rejects.toBeInstanceOf(NotFoundException);
    // The matching tuple resolves it.
    expect((await run(() => svc.getSession('sdoc', DS))).id).toBe('sdoc');
  });

  it('createSession stamps kind/plantId/ownerId and prepares the doctor workspace before /execute', async () => {
    const { svc, run, sessions, doctorRunContext, engine } = setup();
    const out = await run(() => svc.createSession('why yellow?', 'claude', DS));
    const row = sessions.get(out.sessionId) as any;
    expect([row.kind, row.plantId, row.ownerId]).toEqual(['DOCTOR', 'A', 'O']);
    // prepareRun ran BEFORE execute, and the workspace path was injected as the per-run env.
    expect(doctorRunContext.prepareRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: out.sessionId, plantId: 'A', ownerId: 'O' }));
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ env: { PLANT_DOCTOR_SESSION_WORKSPACE: '/ws' } }));
  });

  it('a KNOWLEDGE launch never prepares a doctor workspace', async () => {
    const { svc, run, doctorRunContext, engine } = setup();
    await run(() => svc.createSession('research', 'claude', KS));
    expect(doctorRunContext.prepareRun).not.toHaveBeenCalled();
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }));
  });

  it('deleteSession sweeps the DOCTOR workspace before removing the row', async () => {
    const { svc, run, sessions, doctorRunContext } = setup({
      sessions: [session({ id: 'sdoc', kind: 'DOCTOR', plantId: 'A', ownerId: 'O' } as any)],
      runs: [doneRun({ sessionId: 'sdoc' })],
    });
    await run(() => svc.deleteSession('sdoc', DS));
    expect(doctorRunContext.sweep).toHaveBeenCalledWith('sdoc');
    expect(sessions.has('sdoc')).toBe(false);
  });
});

// Codex fallback gate (Spec 3 §3.2), for BOTH pipelines, on the run-path-resolved (sealed-aware) provider.
describe('KnowledgeChatService — Codex verification gate', () => {
  it('rejects a codex CREATE when the pipeline is unverified, and accepts once verified (dynamic, same instance)', async () => {
    const { svc, run, codexVerification } = setup();
    codexVerification.isVerified.mockResolvedValue(false);
    await expect(run(() => svc.createSession('x', 'codex', KS))).rejects.toBeInstanceOf(UnprocessableEntityException);
    // Flip the record between calls WITHOUT a new service — the next read sees it.
    codexVerification.isVerified.mockResolvedValue(true);
    const out = await run(() => svc.createSession('x', 'codex', KS));
    expect(out.sessionId).toBeTruthy();
  });

  it('a claude create is unaffected by the codex gate', async () => {
    const { svc, run, codexVerification } = setup();
    codexVerification.isVerified.mockResolvedValue(false);
    const out = await run(() => svc.createSession('x', 'claude', KS));
    expect(out.sessionId).toBeTruthy();
  });

  it('rejects a resume of a SEALED codex session whether provider is omitted OR a misleading claude', async () => {
    const seed = () => ({ sessions: [session({ provider: 'codex', providerSessionId: 'thread-1' })], runs: [doneRun({ provider: 'codex' })] });
    for (const requestProvider of [undefined, 'claude'] as const) {
      const { svc, run, codexVerification } = setup(seed());
      codexVerification.isVerified.mockResolvedValue(false);
      await expect(run(() => svc.resume('s1', { prompt: 'go' }, requestProvider, KS))).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
  });

  it('the SAME gate holds for a DOCTOR-scope codex create (both pipelines)', async () => {
    const { svc, run, codexVerification } = setup();
    codexVerification.isVerified.mockResolvedValue(false);
    await expect(run(() => svc.createSession('why?', 'codex', DS))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(codexVerification.isVerified).toHaveBeenCalledWith('DOCTOR');
  });
});

// A sealed, idle DOCTOR session — the precondition `startQueuedSystemTurn` needs to actually start a run.
const doctorSession = (over: Record<string, unknown> = {}) =>
  ({ ...session({ providerSessionId: 'uuid-1' }), kind: 'DOCTOR', plantId: 'A', ownerId: 'O', ...over }) as never as Session;

describe('KnowledgeChatService.startQueuedSystemTurn', () => {
  it('starts a run whose prompt IS the queued message, and consumes it off the session', async () => {
    const { svc, run, sessions, runs, engine } = setup({
      sessions: [doctorSession({ pendingSystemMessage: 'The user declined your request.', pendingSystemMessageProposalId: 'prop-1' })],
      runs: [doneRun()],
    });

    const runId = await run(() => svc.startQueuedSystemTurn('s1'));

    expect(runId).toBeTruthy();
    const created = runs.get(runId!)!;
    // Carried ALONE — no trailing blank from a naive prefix onto the empty prompt.
    expect(created.prompt).toBe('The user declined your request.');
    expect((created as never as Record<string, unknown>).systemMessageState).toBe('CONSUMED');
    expect((created as never as Record<string, unknown>).systemMessageProposalId).toBe('prop-1');
    // At-most-once: it is gone from the session, so a second turn cannot redeliver it.
    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBeNull();
    // It really reached the engine, rather than only being persisted.
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId, resumeSessionId: 'uuid-1' }));
  });

  it('does nothing when no message is queued', async () => {
    const { svc, run, runs } = setup({ sessions: [doctorSession()], runs: [doneRun()] });
    expect(await run(() => svc.startQueuedSystemTurn('s1'))).toBeNull();
    expect(runs.size).toBe(1); // no new run
  });

  it('does nothing on an UNSEALED session — there is no agent thread to continue yet', async () => {
    const { svc, run, sessions, runs } = setup({
      sessions: [doctorSession({ providerSessionId: null, pendingSystemMessage: 'The user declined your request.' })],
    });
    expect(await run(() => svc.startQueuedSystemTurn('s1'))).toBeNull();
    expect(runs.size).toBe(0);
    // The message is NOT consumed — it waits for the owner's first real turn.
    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBe('The user declined your request.');
  });

  it('throws Conflict when a run is already active, LEAVING the message queued for that run successor', async () => {
    // Idle is never pre-checked with a read (that would be a TOCTOU); the activeKey unique index decides.
    const { svc, run, sessions } = setup({
      sessions: [doctorSession({ pendingSystemMessage: 'The user declined your request.' })],
      runs: [activeRun()],
    });
    await expect(run(() => svc.startQueuedSystemTurn('s1'))).rejects.toBeInstanceOf(ConflictException);
    // Nothing was lost: the message is still on the session.
    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBe('The user declined your request.');
  });
});

describe('run admission expires pending proposals (through the real service)', () => {
  it('a new prompt turn expires the PENDING proposal and prefixes the not-approved nudge', async () => {
    // The unit tests drive admitRun directly; this proves the service actually routes through it, which a
    // direct-only test cannot: insertActiveRun could have kept its old inline create and stayed green.
    const { svc, run, runs, proposals, sessions } = setup({
      sessions: [doctorSession()],
      runs: [doneRun()],
      proposals: [{ id: 'prop-1', sessionId: 's1', status: 'PENDING', pendingKey: 'PENDING' }],
    });

    const out = await run(() => svc.resume('s1', { prompt: 'why is it yellow?' }, undefined, DS));

    expect(proposals.get('prop-1').status).toBe('EXPIRED');
    expect(proposals.get('prop-1').pendingKey).toBeNull(); // or the index blocks every future proposal
    expect(runs.get(out.runId)!.prompt).toBe('The user still has not approved the request.\n\nwhy is it yellow?');
    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBeNull(); // consumed
  });

  it('a COMMAND turn expires the proposal but is NOT prefixed, and leaves the nudge queued', async () => {
    const { svc, run, runs, proposals, sessions } = setup({
      sessions: [doctorSession()],
      runs: [doneRun()],
      proposals: [{ id: 'prop-1', sessionId: 's1', status: 'PENDING', pendingKey: 'PENDING' }],
    });

    const out = await run(() => svc.resume('s1', { command: { name: 'compact', args: '' } }, undefined, DS));

    expect(proposals.get('prop-1').status).toBe('EXPIRED');
    expect(runs.get(out.runId)!.prompt).toBeNull();
    expect((runs.get(out.runId)! as never as Record<string, unknown>).commandName).toBe('compact');
    // Prefixing prose onto a command would corrupt it, so the message waits for the next PROMPT turn.
    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBe('The user still has not approved the request.');
  });
});

describe('the launch lease is wired into launch()', () => {
  it('never calls /execute when the codex record turns false during the launch window', async () => {
    // The unit tests prove takeLaunchLease itself; this proves the service actually CONSULTS it. Without
    // this, deleting the lease call would leave every lease test green while runs spawned during a drain.
    const { svc, run, engine, codexVerification, runs } = setup({
      sessions: [session({ providerSessionId: 'uuid-1', provider: 'codex' })],
      runs: [doneRun()],
    });
    // Verified at admission time (so the turn is accepted), drained by the time the lease is taken.
    codexVerification.isVerified.mockResolvedValueOnce(true).mockResolvedValue(false);

    await expect(run(() => svc.resume('s1', { prompt: 'hi' }, undefined, KS))).rejects.toBeInstanceOf(ConflictException);

    expect(engine.execute).not.toHaveBeenCalled();
    // The refused run is terminal and its slot is freed — a leased-but-refused run left active would
    // block the session forever.
    const refused = [...runs.values()].find((r) => r.id !== 'r1')!;
    expect(refused.status).toBe('FAILED');
    expect(refused.activeKey).toBeNull();
  });

  it('restores a consumed system message when the lease is refused', async () => {
    // A refused lease is CONFIRMED pre-spawn, so the nudge must survive for the next run to carry.
    const { svc, run, sessions, codexVerification } = setup({
      sessions: [doctorSession({ provider: 'codex', pendingSystemMessage: 'The user declined your request.' })],
      runs: [doneRun()],
    });
    codexVerification.isVerified.mockResolvedValueOnce(true).mockResolvedValue(false);

    await expect(run(() => svc.resume('s1', { prompt: 'hi' }, undefined, DS))).rejects.toBeInstanceOf(ConflictException);

    expect((sessions.get('s1') as never as Record<string, unknown>).pendingSystemMessage).toBe('The user declined your request.');
  });

  it('reaches /execute normally when the lease is granted', async () => {
    const { svc, run, engine } = setup({ sessions: [session()], runs: [doneRun()] });
    const out = await run(() => svc.resume('s1', { prompt: 'hi' }, undefined, KS));
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId }));
  });
});
