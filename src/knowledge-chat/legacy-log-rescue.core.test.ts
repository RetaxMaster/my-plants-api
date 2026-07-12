import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, readOwnRunLog, type AgentsRealtimeServer } from '@retaxmaster/agents-realtime-server';
import type { Orchestrator } from '@retaxmaster/agents-realtime-server';
import { buildLogIdentity } from '@retaxmaster/agents-realtime-protocol';
import { rescueLegacyLogs } from './legacy-log-rescue.core.js';

// A PRE-1.0 log: raw Claude stream-json, no header line, and — critically — no user prompt and no terminal.
// Those three facts live only in our DB, which is why the migration REQUIRES them as inputs.
//
// This fixture is STRUCTURALLY FAITHFUL to the real thing, and that is the point. It was derived from a line
// census of our four actual legacy logs, and it carries every shape they carry: the `stream_event` deltas
// that are the BULK of a real file (150 of 167 lines in one of them), the `system/hook_*` and
// `system/status` chatter, the benign `rate_limit_event`, and — the ones a hand-written fixture would never
// think of — TWO generations of OUR OWN old sentinels (`claude_rt_exit`, `claude_rt_done`). The package
// skips those as ours rather than counting them corrupt; a fixture without them would prove nothing about
// the files we are actually going to convert.
//
// The CONTENT is synthetic on purpose: these repos are public, and a real transcript is not test data.
const LEGACY = [
  JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
  JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup' }),
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'system', subtype: 'status' }),
  JSON.stringify({ type: 'rate_limit_event', status: 'allowed' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_start' }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0 }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sí, ' } }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'aquí estoy.' } }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_delta' }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' }, session_id: 'stale-id-in-the-file' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Sí, aquí estoy.' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success' }),
  // Ours, not content. The migration must skip these WITHOUT counting them as corrupt — counting them would
  // inflate `stats.corrupt` on every real file and make an operator distrust a conversion that went fine.
  JSON.stringify({ type: 'claude_rt_exit', exit_code: 0 }),
  JSON.stringify({ type: 'claude_rt_done', status: 'succeeded' }),
].join('\n') + '\n';

function fakePrisma(rows: unknown[]) {
  return { knowledgeChatRun: { findMany: vi.fn().mockResolvedValue(rows), update: vi.fn().mockResolvedValue({}) } };
}

describe('rescueLegacyLogs', () => {
  it('converts, adopts, and BACKFILLS the run row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    await writeFile(join(dir, 'run-1.ndjson'), LEGACY);

    const prisma = fakePrisma([{
      id: 'run-1',
      provider: 'claude',
      prompt: '¿Estás ahí?',
      status: 'SUCCEEDED',
      startedAt: new Date(1_700_000_000_000),
      createdAt: new Date(1_700_000_000_000),
      providerSessionId: null,
      sessionTracked: false,
      session: { providerSessionId: 'real-session-uuid' },
    }]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(report.rescued).toEqual(['run-1']);
    // LOSSLESS. Nothing in a real legacy file may come back as an `unsupported` placeholder: not the
    // `stream_event` deltas that carry the entire assistant reply, and not our own old `claude_rt_*`
    // sentinels (the package must recognize those as ours and skip them — counting them corrupt would flag
    // every real file we own and make an operator distrust a conversion that went perfectly).
    expect(report.degraded).toEqual([]);
    // And the assistant's words actually survived the trip — the whole reason the rescue exists.
    expect(await readFile(join(dir, 'run-1.ndjson'), 'utf8')).toContain('aquí estoy.');

    // The converted file is canonical: it opens with the header and carries the USER PROMPT the legacy file
    // never had. Without that, every rescued turn shows the agent answering a blank question.
    const canonical = await readFile(join(dir, 'run-1.ndjson'), 'utf8');
    expect(JSON.parse(canonical.split('\n')[0]).type).toBe('log.header');
    expect(canonical).toContain('¿Estás ahí?');
    // The DB's session id WINS over the stale one in the file.
    expect(canonical).toContain('real-session-uuid');
    expect(canonical).not.toContain('stale-id-in-the-file');

    // MANDATORY: the engine resolves logs by runId through its DURABLE INDEX, never by path. An unadopted
    // file is invisible — a perfect log that 500s with "no log path in the durable run index".
    expect(index.adoptExistingLog).toHaveBeenCalledWith({
      logPath: join(dir, 'run-1.ndjson'),
      startedAtMs: 1_700_000_000_000,
      expect: { runId: 'run-1', provider: 'claude', providerSessionId: 'real-session-uuid' },
    });

    // OURS, and on no upstream checklist: our own all-or-nothing membership rule EXCLUDES a run whose
    // providerSessionId is null / sessionTracked is false. Without this backfill the rescued log is
    // byte-perfect, adopted, and still never read.
    expect(prisma.knowledgeChatRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { providerSessionId: 'real-session-uuid', sessionTracked: true },
    });
  });

  it('leaves the ORIGINAL untouched when it cannot be rescued, and keeps going', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    await writeFile(join(dir, 'run-bad.ndjson'), LEGACY);
    await writeFile(join(dir, 'run-2.ndjson'), LEGACY);

    const prisma = fakePrisma([
      // No agent session id anywhere → we cannot build the expectation the engine will check. Skip, loudly.
      { id: 'run-bad', provider: 'claude', prompt: 'x', status: 'SUCCEEDED', startedAt: new Date(1), createdAt: new Date(1), providerSessionId: null, sessionTracked: false, session: { providerSessionId: null } },
      { id: 'run-2', provider: 'claude', prompt: 'y', status: 'SUCCEEDED', startedAt: new Date(2), createdAt: new Date(2), providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-2' } },
    ]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(report.skipped.map((s) => s.runId)).toEqual(['run-bad']);
    expect(report.rescued).toEqual(['run-2']);           // one bad file does not stop the batch
    expect(await readFile(join(dir, 'run-bad.ndjson'), 'utf8')).toBe(LEGACY); // original intact
  });
});

// FIX 1: `isLegacyLog` alone is NOT the idempotency gate. A canonical file's run row decides whether it is
// genuinely done (`sessionTracked: true`, or no row at all) or only PARTIALLY rescued (`sessionTracked:
// false` — the process died between the write and the backfill). These use a MOCK index: they pin the
// exact decision logic (which files get touched, and how) cheaply; the integration suite below proves the
// repair actually works against the REAL engine index.
// Bootstraps a GENUINE canonical file on disk (real header, real translated content) by running a legacy
// rescue once with a throwaway row + a throwaway mock index. The tests below need real canonical bytes,
// not the raw LEGACY fixture — writing LEGACY verbatim would make `isLegacyLog` see a legacy file, not a
// canonical one, and exercise the wrong branch entirely.
async function writeCanonicalFixture(dir: string, runId: string): Promise<string> {
  const path = join(dir, `${runId}.ndjson`);
  await writeFile(path, LEGACY);
  await rescueLegacyLogs(fakePrisma([{
    id: runId, provider: 'claude', prompt: 'bootstrap prompt', status: 'SUCCEEDED',
    startedAt: new Date(1), createdAt: new Date(1),
    providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'bootstrap-session' },
  }]) as never, dir, { adoptExistingLog: vi.fn() });
  return path;
}

describe('rescueLegacyLogs — a canonical file is not automatically "done" (FIX 1)', () => {
  it('leaves a canonical file with sessionTracked=true COMPLETELY alone (never calls adoptExistingLog)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    // Genuinely finished: the engine itself produced this session (sessionTracked already true), so this
    // file is none of the rescue's business — and adoptExistingLog would THROW if called on it (the
    // package refuses to adopt a run it spawned).
    await writeCanonicalFixture(dir, 'run-finished');
    const prisma = fakePrisma([{
      id: 'run-finished', provider: 'claude', prompt: 'p', status: 'SUCCEEDED',
      startedAt: new Date(10), createdAt: new Date(10),
      providerSessionId: 'sess-finished', sessionTracked: true, session: { providerSessionId: 'sess-finished' },
    }]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(report.alreadyCanonical).toBe(1);
    expect(report.repaired).toEqual([]);
    expect(report.rescued).toEqual([]);
    expect(index.adoptExistingLog).not.toHaveBeenCalled();
    expect(prisma.knowledgeChatRun.update).not.toHaveBeenCalled();
  });

  it('leaves a canonical file with NO run row alone too (none of our business)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    await writeCanonicalFixture(dir, 'run-orphan');
    const prisma = fakePrisma([]); // no matching row at all
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(report.alreadyCanonical).toBe(1);
    expect(index.adoptExistingLog).not.toHaveBeenCalled();
  });

  it('REPAIRS (re-adopts + re-backfills) a canonical file whose run row is still sessionTracked=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    const canonicalPath = join(dir, 'run-partial.ndjson');
    await writeFile(canonicalPath, LEGACY);

    // First pass: a REAL translation, so the file on disk is a genuine canonical log with a real header —
    // exactly the state a crash-after-write leaves behind.
    const bootstrapRow = {
      id: 'run-partial', provider: 'claude', prompt: 'p', status: 'SUCCEEDED',
      startedAt: new Date(1_650_000_000_000), createdAt: new Date(1_650_000_000_000),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-partial' },
    };
    await rescueLegacyLogs(fakePrisma([bootstrapRow]) as never, dir, { adoptExistingLog: vi.fn() });
    const canonicalText = await readFile(canonicalPath, 'utf8');
    expect(JSON.parse(canonicalText.split('\n')[0]).type).toBe('log.header'); // now genuinely canonical

    // Second pass simulates the crash: the file is canonical, but the run row STILL looks pre-1.0 (the
    // backfill from the first pass never happened for real — `fakePrisma`'s `update` is a stub).
    const prisma = fakePrisma([bootstrapRow]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(report.repaired).toEqual(['run-partial']);
    expect(report.rescued).toEqual([]);
    expect(report.alreadyCanonical).toBe(0);
    // startedAtMs and provider come from the log's OWN header, never the DB — see FIX 1.
    expect(index.adoptExistingLog).toHaveBeenCalledWith({
      logPath: canonicalPath,
      startedAtMs: 1_650_000_000_000,
      expect: { runId: 'run-partial', provider: 'claude', providerSessionId: 'sess-partial' },
    });
    expect(prisma.knowledgeChatRun.update).toHaveBeenCalledWith({
      where: { id: 'run-partial' },
      data: { providerSessionId: 'sess-partial', sessionTracked: true },
    });
  });

  // Discovered by running the real script against the local dev DB (see the FIX 1 write-up): a blanket
  // migration backfill (0017) can leave `sessionTracked = false` on a run the engine GENUINELY spawned —
  // `sessionTracked === false` alone is necessary but NOT sufficient evidence of a partial rescue. Calling
  // `adoptExistingLog` on such a file THROWS ("run was SPAWNED by this engine") and would abort the whole
  // batch. The log's own `log.identity` line (written only by the runner, never by the pure translator) is
  // what the code must check first.
  it('does NOT attempt to repair a canonical file that carries a runner identity, even with sessionTracked=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    const path = join(dir, 'run-live.ndjson');

    // Bootstrap genuine canonical bytes, then splice in a `log.identity` line — the one structural fact
    // that marks "this engine spawned this run", exactly as the real runner would leave behind.
    await writeFile(path, LEGACY);
    await rescueLegacyLogs(fakePrisma([{
      id: 'run-live', provider: 'claude', prompt: 'p', status: 'SUCCEEDED',
      startedAt: new Date(20), createdAt: new Date(20),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-live' },
    }]) as never, dir, { adoptExistingLog: vi.fn() });
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    const identityLine = buildLogIdentity({ runId: 'run-live', pid: 4242, procStartTime: 1234 });
    // Right after `user.prompt` (line index 1) is a position the package's own scanner accepts.
    const withIdentity = [...lines.slice(0, 2), identityLine, ...lines.slice(2)].join('\n') + '\n';
    await writeFile(path, withIdentity);

    // A run row that STILL looks pre-1.0 (sessionTracked=false) — the exact state this bug hides behind.
    const prisma = fakePrisma([{
      id: 'run-live', provider: 'claude', prompt: 'p', status: 'SUCCEEDED',
      startedAt: new Date(20), createdAt: new Date(20),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-live' },
    }]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    expect(index.adoptExistingLog).not.toHaveBeenCalled(); // would have THROWN in production
    expect(prisma.knowledgeChatRun.update).not.toHaveBeenCalled();
    expect(report.repaired).toEqual([]);
    expect(report.rescued).toEqual([]);
    // Surfaced via `skipped` (not silently folded into `alreadyCanonical`) so an operator can see it.
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.runId).toBe('run-live');
    expect(report.skipped[0]?.reason).toMatch(/runner identity|spawned/i);
    // The file is completely untouched.
    expect(await readFile(path, 'utf8')).toBe(withIdentity);
  });

  // FIX A: `sawIdentity === false` is STILL not proof of a partial rescue. The engine writes the log's
  // {header, lead} pair BEFORE it tries to start the runner, so a run that failed PRE-SPAWN leaves a
  // canonical, terminal log with NO `log.identity` AND NO `session.started` — and 0017 left its row at
  // sessionTracked=false. Adopting it would throw (the package requires a matching session.started).
  // `sawSessionStarted` is the positive marker of translated (rescue) output; its absence means pre-spawn.
  it('SKIPS a pre-spawn engine failure (no identity, no session.started) and still rescues the next file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    const prespawnPath = join(dir, 'run-prespawn.ndjson');

    // Build genuine canonical bytes, then STRIP the `session.started` line — leaving exactly the shape the
    // engine leaves behind when it wrote the header+lead and then failed before the runner ever came up.
    await writeFile(prespawnPath, LEGACY);
    await rescueLegacyLogs(fakePrisma([{
      id: 'run-prespawn', provider: 'claude', prompt: 'p', status: 'FAILED',
      startedAt: new Date(30), createdAt: new Date(30),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-prespawn' },
    }]) as never, dir, { adoptExistingLog: vi.fn() });
    const stripped = (await readFile(prespawnPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.includes('"session.started"'))
      .join('\n') + '\n';
    await writeFile(prespawnPath, stripped);
    expect(stripped).not.toContain('session.started');
    expect(stripped).not.toContain('log.identity'); // neither marker — the pre-spawn shape

    // ...and a perfectly good LEGACY file right after it in the same batch. The whole point: one bad file
    // must not take the rest of the migration down with it.
    await writeFile(join(dir, 'run-good.ndjson'), LEGACY);

    const prisma = fakePrisma([
      { id: 'run-prespawn', provider: 'claude', prompt: 'p', status: 'FAILED', startedAt: new Date(30), createdAt: new Date(30), providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-prespawn' } },
      { id: 'run-good', provider: 'claude', prompt: 'g', status: 'SUCCEEDED', startedAt: new Date(40), createdAt: new Date(40), providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-good' } },
    ]);
    const index = { adoptExistingLog: vi.fn() };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    // The pre-spawn log is skipped with a clear reason — never adopted (which would have thrown).
    expect(report.skipped.map((s) => s.runId)).toEqual(['run-prespawn']);
    expect(report.skipped[0]?.reason).toMatch(/session\.started/i);
    expect(report.repaired).toEqual([]);
    // ...and the BATCH CONTINUED: the good file was still rescued.
    expect(report.rescued).toEqual(['run-good']);
    expect(index.adoptExistingLog).toHaveBeenCalledTimes(1);
    expect(index.adoptExistingLog).toHaveBeenCalledWith(expect.objectContaining({
      logPath: join(dir, 'run-good.ndjson'),
    }));
    // The pre-spawn file itself was left completely untouched.
    expect(await readFile(prespawnPath, 'utf8')).toBe(stripped);
  });
});

// FIX A, second half — and the more fundamental of the two. A predicate can only exclude the failures we
// FORESAW. Fault isolation holds for the ones we did not: `adoptExistingLog` throws on any door-check
// failure, and an escaping throw in a BATCH job takes every remaining file down with it.
describe('rescueLegacyLogs — one bad file never kills the batch (fault isolation)', () => {
  it('records a THROWING adoptExistingLog as skipped and keeps processing the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    await writeFile(join(dir, 'run-boom.ndjson'), LEGACY);
    await writeFile(join(dir, 'run-after.ndjson'), LEGACY);

    const prisma = fakePrisma([
      { id: 'run-boom', provider: 'claude', prompt: 'a', status: 'SUCCEEDED', startedAt: new Date(1), createdAt: new Date(1), providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-boom' } },
      { id: 'run-after', provider: 'claude', prompt: 'b', status: 'SUCCEEDED', startedAt: new Date(2), createdAt: new Date(2), providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-after' } },
    ]);
    // Explodes on ONE specific file — standing in for any door-check failure we did not foresee. Keyed by
    // runId rather than call order, so the test does not silently depend on readdir's ordering.
    const index = {
      adoptExistingLog: vi.fn((entry: { expect: { runId: string } }) => {
        if (entry.expect.runId === 'run-boom') throw new Error('some unforeseen door-check failure');
      }),
    };

    const report = await rescueLegacyLogs(prisma as never, dir, index);

    // The thrower is reported, not swallowed and not fatal.
    expect(report.skipped.map((s) => s.runId)).toEqual(['run-boom']);
    expect(report.skipped[0]?.reason).toContain('some unforeseen door-check failure');
    // The batch survived it.
    expect(report.rescued).toEqual(['run-after']);
    expect(index.adoptExistingLog).toHaveBeenCalledTimes(2);
  });
});

// FIX C: a run log is SECRET-GRADE (prompt + full agent output + stderr tail); the engine creates them
// 0600. `rename` carries the TEMP file's mode onto the target, so a temp born at the umask default (0644)
// would silently make a rescued admin transcript world-readable.
describe('rescueLegacyLogs — the atomic replace preserves the log file permissions (FIX C)', () => {
  it('keeps a 0600 log at 0600 after the rescue rewrites it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    const path = join(dir, 'run-secret.ndjson');
    await writeFile(path, LEGACY, { mode: 0o600 });
    await chmod(path, 0o600); // defeat the umask — the engine's real logs are exactly this
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const prisma = fakePrisma([{
      id: 'run-secret', provider: 'claude', prompt: 'secret prompt', status: 'SUCCEEDED',
      startedAt: new Date(1), createdAt: new Date(1),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-secret' },
    }]);

    const report = await rescueLegacyLogs(prisma as never, dir, { adoptExistingLog: vi.fn() });
    expect(report.rescued).toEqual(['run-secret']);

    // The rescued file was fully rewritten — and is STILL 0600, not 0644.
    expect(await readFile(path, 'utf8')).toContain('secret prompt');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind in the log directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kc-rescue-'));
    await writeFile(join(dir, 'run-tmp.ndjson'), LEGACY);
    const prisma = fakePrisma([{
      id: 'run-tmp', provider: 'claude', prompt: 'p', status: 'SUCCEEDED',
      startedAt: new Date(1), createdAt: new Date(1),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'sess-tmp' },
    }]);

    await rescueLegacyLogs(prisma as never, dir, { adoptExistingLog: vi.fn() });

    expect(await readdir(dir)).toEqual(['run-tmp.ndjson']);
  });
});

// FIX 6: the mock-index tests above prove `rescueLegacyLogs` CALLS the index correctly, but they prove
// nothing about whether the REAL engine accepts what we hand it, whether `startedAtMs` truly matches the
// header, or whether the rescued conversation is actually replayable afterwards — which is exactly why the
// two BLOCKER defects (FIX 1, FIX 2) shipped green under a mocked index. These use the package's REAL
// durable run index end-to-end.
describe('rescueLegacyLogs — REAL engine durable index (integration)', () => {
  async function buildRealIndex(): Promise<{ server: AgentsRealtimeServer; logRoot: string }> {
    const stateDir = await mkdtemp(join(tmpdir(), 'kc-rescue-state-'));
    const logRoot = await mkdtemp(join(tmpdir(), 'kc-rescue-logroot-'));
    // A minimal orchestrator stub is fine here: adoptExistingLog never calls into it. What must be REAL is
    // the durable index itself (stateDir/logRoot), which is what FIX 1 and FIX 2 are about.
    const orchestrator: Orchestrator = {
      validateTicket: async () => null,
      runStarted: async () => {},
      runFinished: async () => {},
      activeRuns: async () => [],
    };
    const server = createServer({
      port: 18_734, // never bound — we never call server.listen()
      secret: 'integration-test-secret',
      corsOrigins: [],
      timeouts: { runMs: 60_000, bufferMs: 10_000 },
      orchestrator,
      providers: {},
      stateDir,
      logRoot,
    });
    return { server, logRoot };
  }

  function statefulPrisma(rows: Array<Record<string, unknown>>) {
    return {
      knowledgeChatRun: {
        findMany: vi.fn(async () => rows),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (row) Object.assign(row, data);
          return row ?? {};
        }),
      },
    };
  }

  it('adopts a rescued log into the REAL index, and the conversation is genuinely replayable afterwards', async () => {
    const { server, logRoot } = await buildRealIndex();
    const logPath = join(logRoot, 'run-real-1.ndjson');
    await writeFile(logPath, LEGACY);

    const prisma = statefulPrisma([{
      id: 'run-real-1', provider: 'claude', prompt: '¿Sigues ahí?', status: 'SUCCEEDED',
      startedAt: new Date(1_700_000_500_000), createdAt: new Date(1_700_000_500_000),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'real-session-int-1' },
    }]);

    const report = await rescueLegacyLogs(prisma as never, logRoot, server);
    expect(report.rescued).toEqual(['run-real-1']);

    // Read it back through the package's REAL reader — not a mock, the same one the live app uses to
    // restore a conversation. If adoption were broken this throws (OwnRunLogUnavailableError) or the
    // content wouldn't be there.
    const turn = readOwnRunLog(logPath, {
      runId: 'run-real-1',
      provider: 'claude',
      providerSessionId: 'real-session-int-1',
    });
    expect(turn.userPrompt).toBe('¿Sigues ahí?');
    expect(JSON.stringify(turn.events)).toContain('aquí estoy.');
  });

  it('REPAIRS a canonical-but-unfinished file on re-run against the REAL index, not skip it as already canonical', async () => {
    const { server, logRoot } = await buildRealIndex();
    const logPath = join(logRoot, 'run-real-2.ndjson');
    await writeFile(logPath, LEGACY);

    const row = {
      id: 'run-real-2', provider: 'claude', prompt: '¿Ya volviste?', status: 'SUCCEEDED',
      startedAt: new Date(1_700_000_600_000), createdAt: new Date(1_700_000_600_000),
      providerSessionId: null, sessionTracked: false, session: { providerSessionId: 'real-session-int-2' },
    };
    const prisma = statefulPrisma([row]);

    const first = await rescueLegacyLogs(prisma as never, logRoot, server);
    expect(first.rescued).toEqual(['run-real-2']);
    expect(row.sessionTracked).toBe(true);

    // Simulate the crash-after-write state (FIX 1): the canonical bytes already landed on disk (and were
    // already adopted into THIS SAME real index above), but the run row is reset to pre-1.0 shape — exactly
    // what a crash between adoption and the backfill (or a backfill that failed) leaves behind.
    row.providerSessionId = null;
    row.sessionTracked = false;

    const second = await rescueLegacyLogs(prisma as never, logRoot, server);

    expect(second.repaired).toEqual(['run-real-2']);
    expect(second.rescued).toEqual([]);
    expect(second.alreadyCanonical).toBe(0);
    expect(row.sessionTracked).toBe(true);
    expect(row.providerSessionId).toBe('real-session-int-2');

    // Still genuinely replayable through the REAL reader after the repair.
    const turn = readOwnRunLog(logPath, {
      runId: 'run-real-2',
      provider: 'claude',
      providerSessionId: 'real-session-int-2',
    });
    expect(turn.userPrompt).toBe('¿Ya volviste?');
    expect(JSON.stringify(turn.events)).toContain('aquí estoy.');
  });
});
