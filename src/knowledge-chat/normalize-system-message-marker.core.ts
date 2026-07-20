// Spec §3.5, Task 26 — strip the retired `[system] ` marker out of the live database columns.
//
// `KnowledgeChatRun.systemMessageText` and `KnowledgeChatSession.pendingSystemMessage` were both written by
// the pre-3.0.x code as `${LEGACY_SYSTEM_MARKER} ${message}` — the same already-marked constant the old
// `admitRun` composed `prompt` from too. Under the new native system-message transport, a bubble already
// labelled "System" that ALSO shows the literal text "[system]" is the exact duplication this feature
// exists to remove. This module strips it from the two live columns.
const LEGACY_MARKER_PREFIX = '[system] ';

/**
 * ORDERING GUARD (spec §3.5). The log survey — and any promotion it authorises — MUST run first, because
 * the recognizer uses `systemMessageText` as its MATCHING AUTHORITY: normalising that column beforehand
 * destroys the ground truth it depends on. This is enforced, not documented, because the failure is silent
 * (a promotion that finds nothing looks exactly like a corpus with nothing to find).
 */
export function assertSurveyRanFirst(opts: { surveyCompleted: boolean }): void {
  if (!opts.surveyCompleted) {
    throw new Error(
      'Refusing to normalise: the legacy-log survey must run FIRST. Normalising systemMessageText destroys ' +
        'the authority the recognizer matches against. Run `npm run migrate:promote-system-messages` first, ' +
        'record its counts, then re-run this with --after-survey.',
    );
  }
}

const strip = (value: string): string =>
  value.startsWith(LEGACY_MARKER_PREFIX) ? value.slice(LEGACY_MARKER_PREFIX.length) : value;

export async function normalizeMarkerColumns(deps: {
  loadRuns: () => Promise<Array<{ id: string; systemMessageText: string }>>;
  loadSessions: () => Promise<Array<{ id: string; pendingSystemMessage: string }>>;
  // Promise<unknown>, not Promise<void>: TS's "a void-returning callback accepts any return value"
  // leniency does not extend through a Promise wrapper, and the test above legitimately hands an
  // `async (id, to) => updates.push(...)` mock (a Promise<number>). Widening the return type here costs
  // nothing at the real call site — `scripts/normalize-system-message-marker.ts` awaits a Prisma
  // `.update()` as a bare statement, which is Promise<void> either way, itself assignable to Promise<unknown>.
  updateRun: (id: string, value: string) => Promise<unknown>;
  updateSession: (id: string, value: string) => Promise<unknown>;
  surveyCompleted: boolean;
}): Promise<{ runsUpdated: number; sessionsUpdated: number }> {
  assertSurveyRanFirst({ surveyCompleted: deps.surveyCompleted });

  let runsUpdated = 0;
  for (const run of await deps.loadRuns()) {
    const next = strip(run.systemMessageText);
    if (next === run.systemMessageText) continue; // already normalised — idempotent
    await deps.updateRun(run.id, next);
    runsUpdated += 1;
  }

  let sessionsUpdated = 0;
  for (const session of await deps.loadSessions()) {
    const next = strip(session.pendingSystemMessage);
    if (next === session.pendingSystemMessage) continue;
    await deps.updateSession(session.id, next);
    sessionsUpdated += 1;
  }

  // NOTE: `prompt` is DELIBERATELY never rewritten. That is why the column is MIXED after the deploy and
  // why splitStoredPrompt exists — see legacy-prompt-split.ts.
  return { runsUpdated, sessionsUpdated };
}
