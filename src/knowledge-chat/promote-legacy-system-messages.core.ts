import { basename, join } from 'node:path';
import { promoteLegacySystemMessages } from '@retaxmaster/agents-realtime-server';
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

export interface Survey {
  logRoots: string[];
  matches: SurveyMatch[];
  totalMatches: number;
  rescuedMatches: number;
  filesScanned: number;
  perRoot: RootSurveyCount[];
}

/**
 * A READ-ONLY pass over both engines' log roots (spec §3.4, Task 24). For every `.ndjson` file it resolves
 * the run id from the filename (a run's log path is `${logDir}/${runId}.ndjson`), loads that run's
 * consumed-system-message facts, builds the recognizer with `makeRecognizer` — the ONE recognizer
 * implementation, never a second one — and runs `promoteLegacySystemMessages` IN MEMORY. It records
 * `{ path, replacement, promoted }` only when `stats.turnsPromoted > 0`; nothing on disk is touched.
 *
 * `turnsPromoted: 0` on every file is ALSO what a successful RE-RUN of the real promotion looks like — the
 * package skips any `user.prompt` whose next line already contains `turn.input`. So an all-zero survey does
 * not, by itself, distinguish "already applied" from "there was never anything to apply", and this survey —
 * not a bare has-this-run-before flag — is what lets the caller reason about which one it is (via
 * `rescuedMatches`/`filesScanned`, reported before any decision is made).
 */
export async function surveyLogRoots(deps: SurveyDeps): Promise<Survey> {
  const matches: SurveyMatch[] = [];
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

      if (stats.turnsPromoted > 0) {
        const rescued = deps.isRescuedLog(text);
        matches.push({ root, path, replacement: canonical, promoted: stats.turnsPromoted, rescued });
        rootMatches++;
        if (rescued) rootRescued++;
      }
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
  };
}

export interface PromotionDeps {
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
