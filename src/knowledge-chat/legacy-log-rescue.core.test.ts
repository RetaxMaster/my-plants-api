import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
