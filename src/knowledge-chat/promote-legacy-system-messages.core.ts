import { basename, join } from 'node:path';
import { promoteLegacySystemMessages, scanCanonicalLog, validateCanonicalLog, type LogExpectation } from '@retaxmaster/agents-realtime-server';
import { makeRecognizer } from './legacy-system-recognizer.js';

// Everything `makeRecognizer` needs from a run row. Deliberately NOT the whole Prisma row, and deliberately
// NOT a `rescued` flag — see the module doc below for why rescued-ness cannot live here.
export interface RunSystemMessageInfo {
  systemMessageText: string | null;
  systemMessageState: string | null;
}

export interface SurveyDeps {
  // Both engines' log roots (KNOWLEDGE_CHAT_LOG_DIR, PLANT_DOCTOR_LOG_DIR), in the order they are scanned
  // and, later, backed up.
  logRoots: string[];
  readDir: (root: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  loadRun: (runId: string) => Promise<RunSystemMessageInfo>;
  // Structural rescue detector (spec 3.4 Task 24, Correction 2). `rescued` is NOT a fact the database
  // carries: `legacy-log-rescue.core.ts` sets `sessionTracked: true` on a rescued run exactly like on an
  // ordinary one, so no DB column tells the two apart. The fact lives in the LOG file itself — a
  // rescued/translated log never carries a `log.identity` line (only the runner writes one) but always
  // carries a synthesized `session.started` — so the real driver wires this to
  // `scan.ok && !scan.sawIdentity && scan.sawSessionStarted` over `scanCanonicalLog(text)`. Injected here so
  // this module stays a pure orchestration layer and the rule is written once, at the call site that owns
  // the actual log-scanning package call.
  isRescuedLog: (text: string) => boolean;
}

export interface SurveyMatch {
  root: string;
  path: string;
  // The already-computed canonical replacement — never recomputed by promoteSurveyedMatches. Validating
  // every replacement up front, during the read-only survey, is what lets the apply pass write with no
  // further chance to fail on the recognizer/parsing side.
  replacement: string;
  promoted: number;
  rescued: boolean;
}

export interface RootSurveyCount {
  root: string;
  filesScanned: number;
  matches: number;
  rescuedMatches: number;
}

// A file that promoted at least one turn but is NOT recorded as a match — either its replacement failed
// structural validation, or the original log did not carry enough of its own identity to validate against
// in the first place. Surfaced loudly rather than silently folded into "no match": this is the one place
// a real defect (in the recognizer, in `promoteLegacySystemMessages`, or in a malformed source file) would
// show up before it ever reaches disk.
export interface SkippedFile {
  path: string;
  reason: string;
}

export interface Survey {
  logRoots: string[];
  matches: SurveyMatch[];
  totalMatches: number;
  rescuedMatches: number;
  filesScanned: number;
  perRoot: RootSurveyCount[];
  skipped: SkippedFile[];
}

// Build the identity `validateCanonicalLog` checks the REPLACEMENT against, from the ORIGINAL file's own
// header + session.started — never from a second, independently-sourced identity. The replacement must
// describe the SAME run the original already did (promotion only splices a `turn.input` line after an
// existing `user.prompt`; it never touches the header or any session line), so self-consistency is exactly
// the right bar: "did splicing in the turn.input corrupt the file", not "does this match some external
// record". A log with no `session.started` at all, or with more than one DISTINCT provider session id,
// carries no single authoritative identity to validate against, so it is refused rather than guessed at.
function buildSelfExpectation(runId: string, originalText: string): { ok: true; expectation: LogExpectation } | { ok: false; reason: string } {
  const scan = scanCanonicalLog(originalText);
  if (!scan.ok) {
    return { ok: false, reason: `cannot validate replacement: original log failed to scan: ${scan.reason}` };
  }
  const distinctSessionIds = new Set(scan.sessionIds);
  if (distinctSessionIds.size === 0) {
    return { ok: false, reason: 'cannot validate replacement: original log carries no session.started to anchor the validation expectation' };
  }
  if (distinctSessionIds.size > 1) {
    return { ok: false, reason: `cannot validate replacement: original log carries ${distinctSessionIds.size} distinct session ids — refusing to guess which is authoritative` };
  }
  return {
    ok: true,
    expectation: { runId, provider: scan.header.provider, providerSessionId: [...distinctSessionIds][0] },
  };
}

/**
 * A READ-ONLY pass over both engines' log roots (spec §3.4, Task 24). For every `.ndjson` file it resolves
 * the run id from the filename (a run's log path is `${logDir}/${runId}.ndjson`), loads that run's
 * consumed-system-message facts, builds the recognizer with `makeRecognizer` — the ONE recognizer
 * implementation, never a second one — and runs `promoteLegacySystemMessages` IN MEMORY. It records
 * `{ path, replacement, promoted }` only when `stats.turnsPromoted > 0` AND the replacement passes
 * `validateCanonicalLog` against an identity self-derived from the ORIGINAL file (see
 * `buildSelfExpectation`); nothing on disk is touched either way.
 *
 * Validating here, not after the write, is the whole point of surveying first: the engine's log reader is
 * FAIL-CLOSED (one malformed interior line rejects the entire conversation, the same reasoning
 * `legacy-log-rescue.core.ts` documents at its own `validateCanonicalLog` call), so a bad replacement does
 * not degrade a chat, it BRICKS it — and the survey is the one moment that failure is still cheap. A
 * promoted-but-invalid file is never silently dropped either: it is recorded in `skipped` with a named
 * reason, so an operator sees it instead of a quiet, unexplained gap between "promotable" and "promoted".
 *
 * `turnsPromoted: 0` on every file is ALSO what a successful RE-RUN of the real promotion looks like — the
 * package skips any `user.prompt` whose next line already contains `turn.input`. So an all-zero survey does
 * not, by itself, distinguish "already applied" from "there was never anything to apply", and this survey —
 * not a bare has-this-run-before flag — is what lets the caller reason about which one it is (via
 * `rescuedMatches`/`filesScanned`, reported before any decision is made).
 */
export async function surveyLogRoots(deps: SurveyDeps): Promise<Survey> {
  const matches: SurveyMatch[] = [];
  const skipped: SkippedFile[] = [];
  const perRoot: RootSurveyCount[] = [];
  let filesScanned = 0;

  for (const root of deps.logRoots) {
    const entries = await deps.readDir(root);
    const ndjsonFiles = entries.filter((f) => f.endsWith('.ndjson'));

    let rootFilesScanned = 0;
    let rootMatches = 0;
    let rootRescued = 0;

    for (const file of ndjsonFiles) {
      rootFilesScanned++;
      const runId = basename(file, '.ndjson');
      const path = join(root, file);
      const text = await deps.readFile(path);
      const run = await deps.loadRun(runId);
      const recognize = makeRecognizer(run);
      const { canonical, stats } = promoteLegacySystemMessages(text, { recognize });

      if (stats.turnsPromoted === 0) continue;

      const selfExpectation = buildSelfExpectation(runId, text);
      if (!selfExpectation.ok) {
        skipped.push({ path, reason: selfExpectation.reason });
        continue;
      }

      const verdict = validateCanonicalLog(canonical, selfExpectation.expectation);
      if (!verdict.ok) {
        skipped.push({ path, reason: `replacement failed validation: ${verdict.reasons.join('; ')}` });
        continue;
      }

      const rescued = deps.isRescuedLog(text);
      matches.push({ root, path, replacement: canonical, promoted: stats.turnsPromoted, rescued });
      rootMatches++;
      if (rescued) rootRescued++;
    }

    filesScanned += rootFilesScanned;
    perRoot.push({ root, filesScanned: rootFilesScanned, matches: rootMatches, rescuedMatches: rootRescued });
  }

  return {
    logRoots: deps.logRoots,
    matches,
    totalMatches: matches.length,
    rescuedMatches: matches.filter((m) => m.rescued).length,
    filesScanned,
    perRoot,
    skipped,
  };
}

export interface PromotionDeps {
  // NEITHER of these actually stops a process. The real driver implements them as a VERIFICATION that the
  // API / the engines are already down (a TCP port-lock refusal — see acquire-engine-port-lock.ts), on the
  // assumption an operator has already run the real stop (e.g. `pm2 stop my-plants-api`) beforehand. This
  // module only guarantees WHEN they are called (before any backup or write), never that calling them has
  // any side effect on a running process.
  stopApi: () => Promise<void> | void;
  stopEngines: () => Promise<void> | void;
  // Called once per log root (BOTH, never just the one that matched) — the precondition is "the corpus is
  // quiescent", not "the matching file's root is quiescent".
  backup: (root: string) => Promise<void> | void;
  // The atomic-write primitive (temp file in the same directory, then rename) lives in the injected
  // function, not here — this module only guarantees WHEN it is called, never how "atomic" is implemented.
  writeFile: (path: string, content: string) => Promise<void> | void;
}

/**
 * Apply a survey that was already computed — never re-derives it. Returns IMMEDIATELY, before touching
 * `stopApi`, `stopEngines`, `backup`, or `writeFile`, when `survey.totalMatches === 0`: this is the expected
 * production case (spec §3.4 predicts zero matches), and the whole point of surveying first is that a clean
 * corpus never pays the cost of stopping two engines, stopping the API, and backing up two log directories
 * for nothing.
 *
 * Otherwise, in order: stop the API, stop the engines, back up EVERY log root, then write each
 * already-computed replacement. `stopApi` before `stopEngines`: a live API can admit a run whose engine then
 * appends to the very log this pass is about to rewrite, so removing the source of new activity comes
 * first; stopping the engines second catches anything already in flight; only then is it safe to snapshot
 * the directories as the rollback net BEFORE any file is rewritten.
 */
export async function promoteSurveyedMatches(survey: Survey, deps: PromotionDeps): Promise<void> {
  if (survey.totalMatches === 0) return;

  await deps.stopApi();
  await deps.stopEngines();

  for (const root of survey.logRoots) {
    await deps.backup(root);
  }

  for (const match of survey.matches) {
    await deps.writeFile(match.path, match.replacement);
  }
}
