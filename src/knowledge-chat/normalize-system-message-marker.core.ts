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

// A session whose CAS write lost the race — the mailbox slot changed underneath the read. NOT an error:
// the row is left exactly as it was found (never clobbered, never resurrected), and a later re-run picks
// up whatever state it settled into. Surfaced by name, loudly, rather than folded into a silent success —
// an operator recovering from a partial run needs to know which rows this pass genuinely could not touch.
export interface SkippedSession {
  id: string;
  reason: string;
}

export async function normalizeMarkerColumns(deps: {
  loadRuns: () => Promise<Array<{ id: string; systemMessageText: string }>>;
  loadSessions: () => Promise<Array<{ id: string; pendingSystemMessage: string }>>;
  // Promise<unknown>, not Promise<void>: TS's "a void-returning callback accepts any return value"
  // leniency does not extend through a Promise wrapper, and the test below legitimately hands an
  // `async (id, to) => updates.push(...)` mock (a Promise<number>). Widening the return type here costs
  // nothing at the real call site — `scripts/normalize-system-message-marker.ts` awaits a Prisma
  // `.update()` as a bare statement, which is Promise<void> either way, itself assignable to Promise<unknown>.
  //
  // UNCONDITIONAL is correct here — see the big comment above the run loop below for why this column, and
  // only this column, may be blind-written.
  updateRun: (id: string, value: string) => Promise<unknown>;
  // CAS, NOT a plain update — see the big comment above the session loop below for why. `from` is the
  // EXACT value this pass read; the real implementation must guard the write with it (an `updateMany`
  // WHERE clause on that value, MySQL/MariaDB idiom already used by `system-message-delivery.ts`) and
  // return whether the write actually landed (`count === 1`). `false` means someone else's write reached
  // the row first — the caller counts that as a skip, never a retry, never a clobber.
  updateSessionIfUnchanged: (id: string, from: string, to: string) => Promise<boolean>;
  surveyCompleted: boolean;
  // Fire synchronously as each row lands, so a script driving this prints a running paper trail rather
  // than going silent until the whole pass resolves — the property an operator needs if row N throws and
  // the promise this function returns never settles at all.
  onRunUpdated?: (id: string) => void;
  onSessionUpdated?: (id: string) => void;
  onSessionSkipped?: (id: string, reason: string) => void;
}): Promise<{ runsUpdated: number; sessionsUpdated: number; sessionsSkipped: SkippedSession[] }> {
  assertSurveyRanFirst({ surveyCompleted: deps.surveyCompleted });

  // `KnowledgeChatRun.systemMessageText` is safe to blind-write, UNLIKE the session column below. It is set
  // exactly once, inside `admitRun`'s `.create()` (knowledge-chat.service.ts) — a full-repo grep for
  // `systemMessageText:` confirms every other reference is a READ (the recognizer, the turn mapping, the
  // rescue). Nothing in this codebase ever `.update()`s it. So the only way a concurrent write could touch
  // a row this pass has already read is a BRAND NEW run being admitted — which creates a NEW row this pass
  // never saw in the first place (loadRuns() already returned before that insert), not a mutation of the
  // one just read. A blind `update()` therefore cannot lose a race here: there is no race to lose. The next
  // idempotent run picks up whatever landed after this one started.
  let runsUpdated = 0;
  for (const run of await deps.loadRuns()) {
    const next = strip(run.systemMessageText);
    if (next === run.systemMessageText) continue; // already normalised — idempotent
    await deps.updateRun(run.id, next);
    runsUpdated += 1;
    deps.onRunUpdated?.(run.id);
  }

  // `KnowledgeChatSession.pendingSystemMessage` is an ACTIVE MAILBOX SLOT, not a write-once column — it is
  // written by `admitRun` (claiming it onto a new run), by `transitionConsumed`'s restore path, and by
  // `ProposalsService`/`proposal-applier.service.ts` (queuing a fresh notice), and it is read-then-cleared
  // by the next admitted run. `system-message-delivery.ts` (around its `updateMany ... where
  // pendingSystemMessage: null` call) already wrote down why a plain read-then-write on this exact column
  // loses data: the read can go stale in the gap before the write lands, so an unconditional update here
  // would either (a) clobber a NEWER message that landed in that gap — lost for good — or (b) resurrect a
  // message a concurrent run already consumed and cleared, causing a re-delivery. So every write below is a
  // compare-and-swap keyed on the exact value this pass read, mirroring that file's own idiom. Losing the
  // race is not a failure of this migration — the row is left untouched and reported, never retried blindly.
  let sessionsUpdated = 0;
  const sessionsSkipped: SkippedSession[] = [];
  for (const session of await deps.loadSessions()) {
    const next = strip(session.pendingSystemMessage);
    if (next === session.pendingSystemMessage) continue; // already normalised — idempotent
    const applied = await deps.updateSessionIfUnchanged(session.id, session.pendingSystemMessage, next);
    if (applied) {
      sessionsUpdated += 1;
      deps.onSessionUpdated?.(session.id);
    } else {
      const reason =
        'the mailbox slot changed underneath the read (a concurrent write claimed or replaced it) — ' +
        'left untouched; a later re-run picks up whatever state it settles into';
      sessionsSkipped.push({ id: session.id, reason });
      deps.onSessionSkipped?.(session.id, reason);
    }
  }

  // NOTE: `prompt` is DELIBERATELY never rewritten. That is why the column is MIXED after the deploy and
  // why splitStoredPrompt exists — see legacy-prompt-split.ts.
  return { runsUpdated, sessionsUpdated, sessionsSkipped };
}
