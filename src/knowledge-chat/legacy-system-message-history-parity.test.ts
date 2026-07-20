import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTurnInputEvent } from '@retaxmaster/agents-realtime-protocol';
import { promoteLegacySystemMessages, readOwnRunLog } from '@retaxmaster/agents-realtime-server';

// TASK 25 (spec §3.4): the plan's own draft named a helper — `mountAgentChatWithHistory` in
// `my-plants-web/components/AgentChat.test.ts` — that does not exist anywhere in this workspace. Before
// writing that test, this suite MEASURES where the "userMessage: '' vs omitted" divergence actually lands.
//
// A migrated decline-turn (produced by `promoteLegacySystemMessages`, run for real below, against the
// real `makeRecognizer`-shaped recognizer) writes its `turn.input` line BY HAND:
//   { type: "turn.input", systemMessage: "...", userMessage: "" }
// because `LegacySystemSplit.userMessage` is a REQUIRED string and the "alone" shape of `splitStoredPrompt`
// returns `{ userMessage: '' }`.
//
// A NATIVE 3.0.0 decline-turn is built with the real `buildTurnInputEvent`, which OMITS blank fields by
// contract:
//   { type: "turn.input", systemMessage: "..." }               // no userMessage key at all
//
// THE MEASUREMENT: both lines are embedded in an otherwise-identical canonical log (header/lead/identity/
// session.started/deltas/stats/completed/exit/done — the same shape as a real local log, see
// storage/knowledge-chat/*.ndjson) and read back through `readOwnRunLog` — the exact function
// `KnowledgeChatEngineService.loadHistory` uses (via the engine's history authority) to restore a
// conversation. The result: BYTE-IDENTICAL `HistoryTurn` objects.
//
// WHY: `scanCanonicalLog` (the scanner behind `readOwnRunLog`) reads exactly TWO things off a `turn.input`
// line — `ev.systemMessage` (lifted onto `HistoryTurn.systemMessage`) and `ev.attachments` (redacted and
// lifted onto `HistoryTurn.attachments`). It NEVER reads `ev.userMessage` — and `HistoryTurn` itself has no
// `userMessage` field at all. `HistoryTurn.userPrompt` comes from the separate `user.prompt` LEAD line,
// which the migration rewrites to the user's half independently of the `turn.input` line's shape.
//
// CONCLUSION: parity is established SERVER-SIDE, before the API or any browser ever sees the two shapes.
// This is why the test lives here (my-plants-api) rather than as a component render test in my-plants-web —
// it pins the real seam, and is a strictly stronger guarantee than a text-content comparison downstream,
// because it holds for EVERY client that ever calls `loadHistory`, not just the one component under test.
describe('turn.input userMessage divergence: migrated ("") vs native (omitted) — HistoryTurn parity (spec §3.4, Task 25)', () => {
  const SYSTEM_MSG = 'The user declined your request.';
  const SESSION_ID = '3d1aafc5-6214-4793-945f-48b74a86ad38';

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'turn-input-parity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The canonical log SKELETON, structurally derived from a real local file
  // (storage/knowledge-chat/cmrskfjxw003ytszjzygw7unm.ndjson): header, lead, identity, session.started,
  // an assistant delta, run.stats, run.completed, the exit sentinel, and the done line.
  // `turnInputLine: null` builds a PRE-3.0.0 legacy log (no turn.input line at all) — the shape
  // `promoteLegacySystemMessages` expects as its input.
  function buildLog(runId: string, leadText: string, turnInputLine: string | null): string {
    return [
      JSON.stringify({ type: 'log.header', schemaVersion: '1.1.0', provider: 'claude', runId, startedAtMs: 1_784_512_104_129 }),
      JSON.stringify({ type: 'user.prompt', text: leadText }),
      ...(turnInputLine !== null ? [turnInputLine] : []),
      JSON.stringify({ type: 'log.identity', runId, pid: 424_186, procStartTime: 2_432_338 }),
      JSON.stringify({ type: 'session.started', provider: 'claude', providerSessionId: SESSION_ID, model: 'claude-opus-4-8' }),
      JSON.stringify({ type: 'assistant.delta', itemId: 'claude-block-0', text: 'ok' }),
      JSON.stringify({ type: 'run.stats', turns: 1, durationMs: 2392, costUsd: 0.25 }),
      JSON.stringify({ type: 'run.completed', status: 'succeeded' }),
      JSON.stringify({ type: 'agents_rt_exit', exit_code: 0 }),
      JSON.stringify({ type: 'agents_rt_done', status: 'succeeded' }),
    ].join('\n') + '\n';
  }

  it('produces byte-identical HistoryTurn objects for the migrated and the native decline-turn shape', async () => {
    // --- The MIGRATED line: the REAL promoteLegacySystemMessages output, not an imagined shape. The
    // recognizer mirrors makeRecognizer()'s exact-match-against-the-DB rule for the "alone" shape
    // (legacy-system-recognizer.ts + legacy-prompt-split.ts's splitStoredPrompt: prompt === systemMessageText
    // verbatim ⇒ { userMessage: '' }).
    const legacyLog = buildLog('run-legacy-1', SYSTEM_MSG, null);

    const recognize = (userPromptText: string): { systemMessage: string; userMessage: string } | null =>
      userPromptText === SYSTEM_MSG ? { systemMessage: SYSTEM_MSG, userMessage: '' } : null;

    const { canonical: migratedLog, stats } = promoteLegacySystemMessages(legacyLog, { recognize });
    expect(stats.turnsPromoted).toBe(1); // sanity: the migration actually matched and rewrote this turn

    // --- The NATIVE line: the REAL buildTurnInputEvent, never hand-assembled.
    const nativeTurnInputLine = JSON.stringify(buildTurnInputEvent({ systemMessage: SYSTEM_MSG, userMessage: '' }));
    // Contract check on the fixture itself: the native line must NOT carry a userMessage key, or this test
    // would not even be exercising the divergence it claims to.
    expect(JSON.parse(nativeTurnInputLine)).not.toHaveProperty('userMessage');
    // And the migrated line (real migration output) MUST carry userMessage: "" — the other half of the claim.
    const migratedTurnInputLine = migratedLog.split('\n')[2];
    expect(JSON.parse(migratedTurnInputLine)).toMatchObject({ userMessage: '' });

    const nativeLog = buildLog('run-native-1', '', nativeTurnInputLine);

    const migratedPath = join(dir, 'migrated.ndjson');
    const nativePath = join(dir, 'native.ndjson');
    await writeFile(migratedPath, migratedLog);
    await writeFile(nativePath, nativeLog);

    // --- Read BOTH through the real public seam: readOwnRunLog, exactly what history restore calls.
    const migratedTurn = readOwnRunLog(migratedPath, { runId: 'run-legacy-1', provider: 'claude', providerSessionId: SESSION_ID });
    const nativeTurn = readOwnRunLog(nativePath, { runId: 'run-native-1', provider: 'claude', providerSessionId: SESSION_ID });

    // THE MEASUREMENT. If this ever fails, the divergence has started reaching the client, and the fix
    // belongs in scanCanonicalLog / the package (outside this workspace's fence — escalate, do not patch
    // around it here).
    expect(migratedTurn).toEqual(nativeTurn);
    expect(migratedTurn.systemMessage).toBe(SYSTEM_MSG);
    expect(migratedTurn.userPrompt).toBe(''); // both shapes: no user text, from the LEAD line, not from turn.input
  });
});
