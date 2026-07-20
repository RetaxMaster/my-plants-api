import { describe, it, expect, vi } from 'vitest';
import { buildLogHeader } from '@retaxmaster/agents-realtime-protocol';
import { surveyLogRoots, promoteSurveyedMatches, type Survey } from './promote-legacy-system-messages.core.js';

// CORRECTION 1 (measured against the installed package, not assumed from the plan): the plan's draft
// fixtures wrote `{"type":"user.prompt","prompt":"..."}`. Real logs — and the package's own
// `promoteLegacySystemMessages` (dist/index.js), which reads `opts.recognize(event.text)` and WRITES
// `{ type: "user.prompt", text: ... }` — use the key `text`, never `prompt`. All 50 real `user.prompt`
// lines across this repo's 71 local logs use `text`; zero use `prompt`. With the plan's key, `event.text`
// is `undefined`, the recognizer always returns null, and every match-expecting assertion below would be
// vacuous. Every fixture here uses `"text"`.

// CORRECTION 2: the plan hangs `rescued` off `loadRun` (a DB read), but there is no such column and no such
// fact in the DB — `legacy-log-rescue.core.ts` sets `sessionTracked: true` on a rescued run exactly like on
// an ordinary one, so the row cannot tell the two apart. Rescued-ness is STRUCTURAL and lives in the LOG
// file: the real driver wires it to `scanCanonicalLog` and computes
// `scan.ok && !scan.sawIdentity && scan.sawSessionStarted` (no runner identity line, but a synthesized
// session.started). Here it is injected as `isRescuedLog(text)` so the core stays pure/testable — `loadRun`
// returns only `{ systemMessageText, systemMessageState }`, matching what `makeRecognizer` actually needs.

// A GENUINE canonical log (post-code-review addendum): the core module now gates every match through
// `validateCanonicalLog`, built from a self-derived identity (the ORIGINAL file's own header +
// session.started — see `buildSelfExpectation`). So any fixture expected to become a MATCH must be a
// structurally real canonical log — header, a `user.prompt` lead, and a `session.started` — or the
// replacement is correctly refused as unvalidatable and lands in `skipped`, never `matches`. Built with the
// package's own `buildLogHeader`, never a hand-rolled second implementation of the header shape.
function canonicalLog(opts: { runId: string; leadText: string; providerSessionId: string; startedAtMs?: number }): string {
  const header = buildLogHeader({ provider: 'claude', runId: opts.runId, startedAtMs: opts.startedAtMs ?? 1000 });
  const lead = JSON.stringify({ type: 'user.prompt', text: opts.leadText });
  const sessionStarted = JSON.stringify({ type: 'session.started', provider: 'claude', providerSessionId: opts.providerSessionId });
  return [header, lead, sessionStarted].join('\n') + '\n';
}

function userPromptLine(text: string): string {
  return JSON.stringify({ type: 'user.prompt', text });
}

const NOT_RESCUED = () => false;

// Fixture provenance (same observed shape legacy-system-recognizer.test.ts documents): the marker sits on
// BOTH `prompt`/log-text and `systemMessageText` as the pre-3.0.x code wrote them.
const MARKED = '[system] The user declined your request.';

describe('the survey-first migration (spec 3.4, Task 24)', () => {
  it('reports a count and makes NO DESTRUCTIVE MOVE when the corpus has no matches', async () => {
    // The expected production case. No engine stop, no backup, no file rewritten.
    const stopApi = vi.fn();
    const stopEngines = vi.fn();
    const backup = vi.fn();
    const writeFile = vi.fn();

    const survey = await surveyLogRoots({
      logRoots: ['/tmp/logs-a', '/tmp/logs-b'],
      readDir: async () => ['run-1.ndjson'],
      readFile: async () => `${userPromptLine('How is my fern?')}\n`,
      loadRun: async () => ({ systemMessageText: null, systemMessageState: null }),
      isRescuedLog: NOT_RESCUED,
    });

    expect(survey.totalMatches).toBe(0);
    expect(survey.rescuedMatches).toBe(0);
    expect(survey.filesScanned).toBe(2); // one file per root, both roots scanned
    expect(survey.skipped).toEqual([]);

    await promoteSurveyedMatches(survey, { stopApi, stopEngines, backup, writeFile });

    expect(stopApi).not.toHaveBeenCalled();
    expect(stopEngines).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('reports the RESCUED runs separately, as the subset where a match is actually plausible', async () => {
    const text = canonicalLog({ runId: 'run-9', leadText: `${MARKED}\n\nHow is my fern?`, providerSessionId: 'sess-9' });

    const survey = await surveyLogRoots({
      logRoots: ['/tmp/logs-a'],
      readDir: async () => ['run-9.ndjson'],
      readFile: async () => text,
      loadRun: async () => ({ systemMessageText: MARKED, systemMessageState: 'CONSUMED' }),
      // Structural rescue signal, injected — the real driver derives this from scanCanonicalLog, never a
      // DB flag (Correction 2).
      isRescuedLog: () => true,
    });

    expect(survey.skipped).toEqual([]);
    expect(survey.totalMatches).toBe(1);
    expect(survey.rescuedMatches).toBe(1);
    expect(survey.matches[0]).toMatchObject({
      path: '/tmp/logs-a/run-9.ndjson',
      promoted: 1,
      rescued: true,
    });
  });

  it('covers BOTH engines log roots', async () => {
    const readDir = vi.fn(async (_root: string) => [] as string[]);

    await surveyLogRoots({
      logRoots: ['/tmp/logs-a', '/tmp/logs-b'],
      readDir,
      readFile: async () => '',
      loadRun: async () => ({ systemMessageText: null, systemMessageState: null }),
      isRescuedLog: NOT_RESCUED,
    });

    expect(readDir.mock.calls.map(([root]) => root)).toEqual(['/tmp/logs-a', '/tmp/logs-b']);
  });

  it('refuses a promotable turn whose replacement fails structural validation, and says so loudly', async () => {
    // A "canonical" file whose header claims a DIFFERENT runId than its own filename — exactly the kind of
    // corruption validateCanonicalLog exists to catch. promoteLegacySystemMessages happily promotes the
    // turn (it never looks at the header at all); the survey must still refuse to record it as a match.
    const text = canonicalLog({ runId: 'some-other-run', leadText: `${MARKED}\n\nHow is my fern?`, providerSessionId: 'sess-x' });

    const survey = await surveyLogRoots({
      logRoots: ['/tmp/logs-a'],
      readDir: async () => ['run-mismatched.ndjson'],
      readFile: async () => text,
      loadRun: async () => ({ systemMessageText: MARKED, systemMessageState: 'CONSUMED' }),
      isRescuedLog: NOT_RESCUED,
    });

    expect(survey.totalMatches).toBe(0);
    expect(survey.matches).toEqual([]);
    expect(survey.skipped).toHaveLength(1);
    expect(survey.skipped[0].path).toBe('/tmp/logs-a/run-mismatched.ndjson');
    expect(survey.skipped[0].reason).toMatch(/failed validation/);
  });

  it('computes and validates EVERY replacement before writing ANY file', async () => {
    // Everything quiesced BEFORE the backup, backup BEFORE any write, and every replacement computed up
    // front: promoteLegacySystemMessages is pure and fails loudly per call, but a script that has already
    // replaced earlier files is only PARTIALLY APPLIED — the backup, not the function's purity, is the
    // rollback. The API is stopped too: a live API admits runs that append to the very logs being rewritten.
    const runA = canonicalLog({ runId: 'run-a', leadText: `${MARKED}\n\nHow is my fern?`, providerSessionId: 'sess-a' });
    const runB = canonicalLog({ runId: 'run-b', leadText: `${MARKED}\n\nShould I repot?`, providerSessionId: 'sess-b' });
    const filesByPath: Record<string, string> = {
      '/tmp/logs-a/run-a.ndjson': runA,
      '/tmp/logs-a/run-b.ndjson': runB,
    };

    const survey = await surveyLogRoots({
      logRoots: ['/tmp/logs-a'],
      readDir: async () => ['run-a.ndjson', 'run-b.ndjson'],
      readFile: async (path) => filesByPath[path],
      loadRun: async () => ({ systemMessageText: MARKED, systemMessageState: 'CONSUMED' }),
      isRescuedLog: NOT_RESCUED,
    });

    expect(survey.skipped).toEqual([]);
    expect(survey.totalMatches).toBe(2);

    const order: string[] = [];
    const stopApi = vi.fn(async () => { order.push('stop-api'); });
    const stopEngines = vi.fn(async () => { order.push('stop-engines'); });
    const backup = vi.fn(async (_root: string) => { order.push('backup'); });
    const writeFile = vi.fn(async (_path: string, _content: string) => { order.push('write'); });

    await promoteSurveyedMatches(survey, { stopApi, stopEngines, backup, writeFile });

    expect(order.slice(0, 3)).toEqual(['stop-api', 'stop-engines', 'backup']);
    expect(order.filter((o) => o === 'write')).toHaveLength(2);

    // CONTENT, not just count: each match's OWN (path, replacement) pair must reach writeFile — a defect
    // that writes match A's replacement to match B's path (a scrambled write) passes a count-only
    // assertion but must not pass this one. Compared as SORTED pairs since only "computed before written"
    // is promised, not the write order relative to `survey.matches`.
    const expectedPairs = survey.matches.map((m) => JSON.stringify([m.path, m.replacement])).sort();
    const actualPairs = writeFile.mock.calls.map(([path, content]) => JSON.stringify([path, content])).sort();
    expect(actualPairs).toEqual(expectedPairs);
  });

  it('backs up EVERY log root, not just the one that matched', async () => {
    const survey: Survey = {
      logRoots: ['/tmp/logs-a', '/tmp/logs-b'],
      matches: [{ root: '/tmp/logs-a', path: '/tmp/logs-a/run-1.ndjson', replacement: 'x', promoted: 1, rescued: false }],
      totalMatches: 1,
      rescuedMatches: 0,
      filesScanned: 2,
      perRoot: [
        { root: '/tmp/logs-a', filesScanned: 1, matches: 1, rescuedMatches: 0 },
        { root: '/tmp/logs-b', filesScanned: 1, matches: 0, rescuedMatches: 0 },
      ],
      skipped: [],
    };

    const backup = vi.fn(async (_root: string) => {});
    await promoteSurveyedMatches(survey, { stopApi: vi.fn(), stopEngines: vi.fn(), backup, writeFile: vi.fn() });

    expect(backup.mock.calls.map(([root]) => root)).toEqual(['/tmp/logs-a', '/tmp/logs-b']);
  });

  it('finds nothing in a log whose turn was ALREADY promoted (the idempotency property)', async () => {
    // The fixture already carries the turn.input line a previous promotion would have written; the claim is
    // that the package skips a turn already followed by one.
    const userLine = userPromptLine('How is my fern?');
    const turnLine = JSON.stringify({ type: 'turn.input', systemMessage: MARKED, userMessage: 'How is my fern?' });

    const survey = await surveyLogRoots({
      logRoots: ['/tmp/logs-a'],
      readDir: async () => ['run-1.ndjson'],
      readFile: async () => `${userLine}\n${turnLine}\n`,
      loadRun: async () => ({ systemMessageText: MARKED, systemMessageState: 'CONSUMED' }),
      isRescuedLog: NOT_RESCUED,
    });

    expect(survey.totalMatches).toBe(0);
    expect(survey.skipped).toEqual([]);
  });
});
