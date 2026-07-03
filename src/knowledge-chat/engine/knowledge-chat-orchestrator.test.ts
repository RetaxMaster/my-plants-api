import { describe, expect, it } from 'vitest';
import { KnowledgeChatOrchestrator } from './knowledge-chat-orchestrator.js';

type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
interface Run { id: string; sessionId: string; status: Status; activeKey: string | null; pid: number | null; procStartTime: string | null; startedAt: Date | null; finishedAt: Date | null; exitCode: number | null; error: string | null }
interface Session { id: string; claudeSessionId: string | null }

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
      findMany: async ({ where, include }: any) => {
        const out = [...runMap.values()].filter((r) => matches(r, where));
        return include?.session ? out.map((r) => ({ ...r, session: sessMap.get(r.sessionId) })) : out;
      },
    },
    knowledgeChatSession: {
      updateMany: async ({ where, data }: any) => {
        const s = sessMap.get(where.id);
        if (!s || (where.claudeSessionId === null && s.claudeSessionId !== null)) return { count: 0 };
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
  it('first call stamps RUNNING + pid + startedAt; sets claudeSessionId only when the UUID arrives', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', status: 'QUEUED', activeKey: 'ACTIVE', pid: null, procStartTime: null, startedAt: null, finishedAt: null, exitCode: null, error: null };
    const session: Session = { id: 's1', claudeSessionId: null };
    const prisma = makePrismaFake([run], [session]);
    const orch = new KnowledgeChatOrchestrator(prisma as any, tickets, env);

    // First call (spawn): sessionId null → stamps startedAt, claudeSessionId still null.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: null });
    expect(run.status).toBe('RUNNING');
    expect(run.pid).toBe(1234);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(session.claudeSessionId).toBeNull();
    const firstStartedAt = run.startedAt;

    // Second call (UUID appears): stamps claudeSessionId once; does NOT move startedAt.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: 'uuid-abc' });
    expect(session.claudeSessionId).toBe('uuid-abc');
    expect(run.startedAt).toBe(firstStartedAt);

    // Third call with a different uuid must NOT clobber the captured one.
    await orch.runStarted('r1', { pid: 1234, procStartTime: '999', sessionId: 'uuid-xyz' });
    expect(session.claudeSessionId).toBe('uuid-abc');
  });

  it('never resurrects a terminal run', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', status: 'CANCELLED', activeKey: null, pid: null, procStartTime: null, startedAt: null, finishedAt: new Date(), exitCode: null, error: null };
    const prisma = makePrismaFake([run], [{ id: 's1', claudeSessionId: null }]);
    const orch = new KnowledgeChatOrchestrator(prisma as any, tickets, env);
    await orch.runStarted('r1', { pid: 1, procStartTime: '1', sessionId: null });
    expect(run.status).toBe('CANCELLED'); // untouched
  });
});

describe('KnowledgeChatOrchestrator.runFinished', () => {
  const mk = (status: Status = 'RUNNING'): Run => ({ id: 'r1', sessionId: 's1', status, activeKey: status === 'QUEUED' || status === 'RUNNING' ? 'ACTIVE' : null, pid: 42, procStartTime: '9', startedAt: new Date(), finishedAt: null, exitCode: null, error: null });

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
      { id: 'r1', sessionId: 's1', status: 'RUNNING', activeKey: 'ACTIVE', pid: 100, procStartTime: '555', startedAt: new Date(1_000_000), finishedAt: null, exitCode: null, error: null },
      { id: 'r2', sessionId: 's2', status: 'QUEUED', activeKey: 'ACTIVE', pid: null, procStartTime: null, startedAt: null, finishedAt: null, exitCode: null, error: null },
      { id: 'r3', sessionId: 's3', status: 'SUCCEEDED', activeKey: null, pid: 7, procStartTime: '1', startedAt: new Date(), finishedAt: new Date(), exitCode: 0, error: null },
    ];
    const sessions: Session[] = [{ id: 's1', claudeSessionId: 'uuid-1' }, { id: 's2', claudeSessionId: null }, { id: 's3', claudeSessionId: 'uuid-3' }];
    const orch = new KnowledgeChatOrchestrator(makePrismaFake(runs, sessions) as any, tickets, env);
    const active = await orch.activeRuns();
    expect(active).toEqual([
      { runId: 'r1', logPath: '/logs/r1.ndjson', pid: 100, procStartTime: '555', startedAtMs: 1_000_000, sessionId: 'uuid-1' },
    ]);
  });
});
