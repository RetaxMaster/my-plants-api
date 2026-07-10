import type { Task } from '@prisma/client';

// The single seam that owns the per-task meaning of `TaskOverride.nextDueOn` (spec F3.1).
//
// WATER (and every task except REPOT) keeps REPLACE semantics — the owner's chosen date beats the formula
// until the next DONE. That is harmless there: a DONE arrives every few days, so the override is short-lived.
//
// REPOT uses a FLOOR — `max(computed, override)`. Its cycle is 12-24 MONTHS, and the override is deleted only
// on a DONE, so under REPLACE the first postpone for ANY reason PINS the date until the next real repot:
// `crowdingFactor`, `R_REF_plant`, `residualFactor` and `adjustment` all stop affecting anything for up to
// two years. Worse, a `could-not-check` snooze to tomorrow would pin the date to tomorrow FOREVER, so the
// task shows overdue and never moves again. A floor can only push a date FORWARD from today; it can never
// pin a future date, and it never masks the engine.
//
// The distinction is ENCODED here and dispatched by `task`. It is NEVER left as two meanings behind one
// column, distinguishable only by reading `task` at each call site (the workspace anti-fork rule).
//
// VERIFIED, not assumed (F3.1's open question): is a postponed WATER date always >= its freshly computed
// date, so that `max()` would collapse the two rules into one? It is NOT. An owner can snooze a watering to
// a date EARLIER than the date the engine recomputes after a profile change (e.g. moving the plant to a
// hotter place shortens the interval). Folding WATER into the floor would then silently ignore the owner's
// snooze. REPLACE is therefore kept as a genuinely distinct branch — and the anti-fork rule is satisfied by
// ONE function that dispatches, not by pretending the two rules are the same rule.
export function resolveDue(task: Task, computed: Date, override: Date | null | undefined): Date {
  if (override == null) return computed;
  if (task === 'REPOT') {
    // FLOOR: the later of the two. A snooze pushes forward; the engine is never masked.
    return override.getTime() > computed.getTime() ? override : computed;
  }
  // REPLACE: the override wins (shipped WATER/other-task behaviour, unchanged).
  return override;
}
