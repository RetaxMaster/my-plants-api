import { describe, expect, it, vi } from 'vitest';
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
interface Run { id: string; sessionId: string; prompt: string; status: Status; activeKey: string | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date; error: string | null; pid: number | null; procStartTime: string | null; exitCode: number | null }
interface Session { id: string; claudeSessionId: string | null; title: string; createdByUserId: string | null; createdAt: Date; updatedAt: Date }

const actor = (userId = 'admin-user') => ({ userId, username: 'root', ownerId: 'o', role: 'ADMIN' as const, jti: 'j', exp: 9e9 });
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

function setup(seed: { sessions?: Session[]; runs?: Run[] } = {}) {
  let seq = 0;
  // Offset generated ids well past any seeded id (seeds use r1/r2/s1) so a freshly created run/session
  // never overwrites a seeded row in the in-memory map.
  const nextId = (p: string) => `${p}${1000 + ++seq}`;
  const sessions = new Map((seed.sessions ?? []).map((s) => [s.id, s]));
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
      create: async ({ data }: any) => { const s: Session = { id: nextId('s'), claudeSessionId: null, createdAt: new Date(), updatedAt: new Date(), createdByUserId: null, ...data }; sessions.set(s.id, s); return s; },
      findUnique: async ({ where, include }: any) => withRuns(sessions.get(where.id), include),
      findMany: async ({ include }: any = {}) => [...sessions.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((s) => withRuns(s, include)),
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
      findUnique: async ({ where }: any) => runs.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...runs.values()].filter((r) => (where?.sessionId ? r.sessionId === where.sessionId : true) && (where?.activeKey !== undefined ? r.activeKey === where.activeKey : true)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      update: async ({ where, data }: any) => { const r = runs.get(where.id); Object.assign(r, data); return r; },
      updateMany: async ({ where, data }: any) => { let count = 0; for (const r of runs.values()) { const active = where.status?.in ? where.status.in.includes(r.status) : true; if ((where.id ? r.id === where.id : where.sessionId ? r.sessionId === where.sessionId : true) && active) { Object.assign(r, data); count++; } } return { count }; },
    },
  } as any;

  const engine = { execute: vi.fn(async () => {}) };
  const tickets = { mint: vi.fn(async (_runId: string) => 'raw-ticket') };
  const logDir = mkdtempSync(join(tmpdir(), 'kchat-'));
  const env = { KNOWLEDGE_CHAT_LOG_DIR: logDir, KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000, KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000 } as any;

  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new KnowledgeChatService(db, engine as any, tickets as any, owner, env);
  const run = <T>(fn: () => Promise<T>, a = actor()) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, engine, tickets, sessions, runs, logDir };
}

// Seed helpers — an ACTIVE run carries activeKey 'ACTIVE'; a terminal run carries null.
const activeRun = (over: Partial<Run> = {}): Run => ({ id: 'r1', sessionId: 's1', prompt: 'p', status: 'RUNNING', activeKey: 'ACTIVE', startedAt: new Date(), finishedAt: null, createdAt: new Date(), error: null, pid: 10, procStartTime: '1', exitCode: null, ...over });
const doneRun = (over: Partial<Run> = {}): Run => ({ id: 'r1', sessionId: 's1', prompt: 'p', status: 'SUCCEEDED', activeKey: null, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(), error: null, pid: null, procStartTime: null, exitCode: 0, ...over });
const session = (over: Partial<Session> = {}): Session => ({ id: 's1', claudeSessionId: 'uuid-1', title: 't', createdByUserId: null, createdAt: new Date(), updatedAt: new Date(), ...over });

describe('KnowledgeChatService.createSession', () => {
  it('creates a session + first (active) run, truncates the log file, mints a ticket, and calls /execute', async () => {
    const { svc, run, engine, tickets, sessions, runs, logDir } = setup();
    const out = await run(() => svc.createSession('Research Monstera deliciosa care'));
    expect(out.ticket).toBe('raw-ticket');
    expect(sessions.get(out.sessionId)?.title).toBe('Research Monstera deliciosa care');
    expect(sessions.get(out.sessionId)?.createdByUserId).toBe('admin-user');
    expect(runs.get(out.runId)?.activeKey).toBe('ACTIVE'); // holds the unique slot
    expect(existsSync(join(logDir, `${out.runId}.ndjson`))).toBe(true); // created/truncated
    expect(tickets.mint).toHaveBeenCalledWith(out.runId);
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId, resumeSessionId: null, logPath: join(logDir, `${out.runId}.ndjson`) }));
  });

  it('truncates the title to ~160 chars', async () => {
    const { svc, run, sessions } = setup();
    const long = 'x'.repeat(500);
    const out = await run(() => svc.createSession(long));
    expect(sessions.get(out.sessionId)!.title.length).toBe(160);
  });

  it('marks the run FAILED (activeKey cleared) and rethrows when /execute fails (never leaves it QUEUED)', async () => {
    const { svc, run, engine, runs } = setup();
    engine.execute.mockRejectedValueOnce(new Error('engine down'));
    await expect(run(() => svc.createSession('boom'))).rejects.toThrow();
    const r = [...runs.values()][0];
    expect(r.status).toBe('FAILED');
    expect(r.activeKey).toBeNull(); // slot freed so the session isn't permanently blocked
  });
});

describe('KnowledgeChatService.resume', () => {
  const seedResumable = () => ({ sessions: [session({ createdByUserId: 'admin-user' })], runs: [doneRun({ prompt: 'first' })] });

  it('adds a run and calls /execute with resumeSessionId = claudeSessionId', async () => {
    const { svc, run, engine } = setup(seedResumable());
    const out = await run(() => svc.resume('s1', 'follow-up question'));
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId, resumeSessionId: 'uuid-1' }));
  });

  it('422 when claudeSessionId is null (not yet resumable) — real HTTP status, not just the class', async () => {
    const { svc, run } = setup({ sessions: [session({ claudeSessionId: null })], runs: [doneRun({ status: 'FAILED', exitCode: 1, error: 'x' })] });
    const err = await run(() => svc.resume('s1', 'x')).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getStatus()).toBe(422);
  });

  it('404 for an unknown session', async () => {
    const { svc, run } = setup();
    await expect(run(() => svc.resume('nope', 'x'))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('single-active-run guard (DB-enforced, atomic)', () => {
  it('409 when a genuinely live (recent) run is active — the unique insert is rejected', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [activeRun()] });
    await expect(run(() => svc.resume('s1', 'x'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('reconciles a STALE active run to FAILED (activeKey cleared), then proceeds', async () => {
    const old = new Date(Date.now() - 3 * 3_600_000); // 3h ago, past timeout+buffer
    const { svc, run, engine, runs } = setup({ sessions: [session({ createdAt: old, updatedAt: old })], runs: [activeRun({ startedAt: old, createdAt: old })] });
    const out = await run(() => svc.resume('s1', 'x'));
    expect(runs.get('r1')!.status).toBe('FAILED'); // reconciled
    expect(runs.get('r1')!.activeKey).toBeNull(); // slot freed
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: out.runId }));
  });

  it('two concurrent starts on one session → exactly one succeeds, the other gets 409', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [doneRun()] });
    const results = await run(() => Promise.allSettled([svc.resume('s1', 'a'), svc.resume('s1', 'b')]));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
  });
});

describe('KnowledgeChatService.deleteSession', () => {
  it('409 when a run is active', async () => {
    const { svc, run } = setup({ sessions: [session()], runs: [activeRun()] });
    await expect(run(() => svc.deleteSession('s1'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes the session + its NDJSON logs when idle', async () => {
    const { svc, run, sessions, logDir } = setup({ sessions: [session()], runs: [doneRun()] });
    writeFileSync(join(logDir, 'r1.ndjson'), 'line');
    await run(() => svc.deleteSession('s1'));
    expect(sessions.has('s1')).toBe(false);
    expect(existsSync(join(logDir, 'r1.ndjson'))).toBe(false);
  });
});

describe('KnowledgeChatService.getRunLog', () => {
  it('returns the raw file contents', async () => {
    const { svc, run, logDir } = setup({ runs: [doneRun()] });
    writeFileSync(join(logDir, 'r1.ndjson'), '{"a":1}\n{"b":2}');
    expect(await run(() => svc.getRunLog('r1'))).toBe('{"a":1}\n{"b":2}');
  });

  it('404 when the file is gone', async () => {
    const { svc, run } = setup({ runs: [doneRun()] });
    await expect(run(() => svc.getRunLog('r1'))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeChatService list/detail', () => {
  it('lists sessions newest-first with latest-run status + turns count', async () => {
    const { svc, run } = setup({
      sessions: [session({ title: 'A', createdAt: new Date(1000) })],
      runs: [doneRun({ id: 'r1', createdAt: new Date(1000), startedAt: new Date(1000) }), activeRun({ id: 'r2', prompt: 'p2', startedAt: new Date(2000), createdAt: new Date(2000), pid: 1 })],
    });
    const list = await run(() => svc.listSessions());
    expect(list[0]).toEqual(expect.objectContaining({ id: 's1', claudeSessionId: 'uuid-1', title: 'A', status: 'RUNNING', turns: 2 }));
  });

  it('detail maps ordered turns with isActive + logUrl', async () => {
    const { svc, run } = setup({ sessions: [session({ title: 'A' })], runs: [activeRun({ prompt: 'p1', pid: 1 })] });
    const detail = await run(() => svc.getSession('s1'));
    expect(detail.claudeSessionId).toBe('uuid-1');
    expect(detail.turns[0]).toEqual({ runId: 'r1', prompt: 'p1', status: 'RUNNING', isActive: true, logUrl: '/knowledge-chat/runs/r1/log' });
  });
});
