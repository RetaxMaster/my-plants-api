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

function setup(seed: { sessions?: Session[]; runs?: Run[] } = {}) {
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
    // User.ownerId is @unique: resolve THE user of an owner (the doctor token's subject, Spec 3 §3.3).
    user: {
      findUnique: async ({ where }: any) => ({ id: `u-${where.ownerId}`, username: `user-${where.ownerId}`, ownerId: where.ownerId }),
    },
    // The fake is already in-memory and single-threaded, so a transaction is just "run the callback".
    $transaction: async (fn: any) => fn(db),
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
  return { svc, run, engine, tickets, sessions, runs, logDir, doctorRunContext, codexVerification };
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
