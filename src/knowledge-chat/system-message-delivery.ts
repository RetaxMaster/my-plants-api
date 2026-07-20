import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EngineFailureException } from './engine/engine-error.js';

const logger = new Logger('SystemMessageDelivery');

export type LaunchFailureClass = 'PRE_SPAWN' | 'AMBIGUOUS';

/** The terminal states a CONSUMED message may settle into. CONSUMED is the only non-terminal one. */
type SettledState = 'DELIVERED' | 'RESTORED' | 'DROPPED';

type ConsumedRun = {
  id: string;
  sessionId: string;
  systemMessageText: string | null;
  systemMessageProposalId: string | null;
  systemMessageState: string | null;
};

/**
 * `/execute` is a plain POST with no idempotency key, so a failure means either "the engine never started
 * the run" or "it started and the response was lost". Restoring blindly would re-deliver a message the
 * agent already received, breaking at-most-once (spec 5.5.4).
 *
 * The default is AMBIGUOUS, deliberately: the two errors are NOT symmetric. Wrongly classifying something
 * as PRE_SPAWN restores a message the agent already read, which it receives as a second refusal for the
 * same proposal. Wrongly classifying as AMBIGUOUS only defers the decision to reconciliation, which can
 * establish the truth. Only failures that PROVE the request never reached a process are PRE_SPAWN.
 */
/** The syscall codes that PROVE no response was ever received, so the request never reached a process. */
const PRE_SPAWN_SYSCALL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/**
 * Walk an error's `cause` chain (and any `AggregateError.errors` branches) looking for a syscall code that
 * proves the request never reached a spawned process.
 *
 * Bounded by a depth cap and a `seen` set: a `cause` chain is attacker-irrelevant here but IS allowed to be
 * cyclic, and an unbounded walk on the failure path would turn an engine outage into a hang.
 */
function hasPreSpawnSyscallCode(err: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (depth > 8 || err === null || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && PRE_SPAWN_SYSCALL_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => hasPreSpawnSyscallCode(x, seen, depth + 1))) return true;
  return hasPreSpawnSyscallCode(e.cause, seen, depth + 1);
}

export function classifyLaunchFailure(err: unknown): LaunchFailureClass {
  // A mapped engine failure is a CONFIRMED refusal: /execute answered before spawning anything, so the
  // queued message is provably still undelivered and must be restored. Only 4xx qualifies — a 5xx may have
  // been returned after the run already spawned, which is exactly the AMBIGUOUS case the protocol defaults
  // to.
  //
  // BE PRECISE ABOUT WHAT THIS BRANCH DOES AND DOES NOT REPLACE. `EngineFailureException` extends
  // `HttpException`, which sets a numeric `.status` own property, so the generic status check below would
  // already classify these identically — this branch is kept for explicitness about the one error type we
  // mint ourselves, NOT because the generic check stopped working. Everything else below is still live and
  // must not be removed as "dead": in particular, a `fetch()` that never gets a response at all (the engine
  // is down mid-deploy) rejects with `ECONNREFUSED`/`ENOTFOUND` and never becomes an
  // `EngineFailureException` — that is a genuine pre-spawn proof this function would otherwise lose.
  if (err instanceof EngineFailureException) {
    return err.mapped.status >= 400 && err.mapped.status < 500 ? 'PRE_SPAWN' : 'AMBIGUOUS';
  }
  const e = (err ?? {}) as { code?: string; status?: number };
  // ⚠️ THE SYSCALL CODE IS NOT ON THE ERROR WE ACTUALLY RECEIVE — IT IS ON ITS `cause`.
  //
  // `KnowledgeChatEngineService.execute()` calls the global `fetch` (undici). A refused connection does
  // NOT reject with an error carrying `code: 'ECONNREFUSED'`; it rejects with `TypeError: fetch failed`
  // whose `code` is `undefined` and whose `cause` carries the syscall code. Measured on this runtime
  // (Node v24.13.1):
  //
  //   fetch('http://127.0.0.1:54999') -> TypeError('fetch failed'), e.code === undefined,
  //                                      e.cause.code === 'ECONNREFUSED'
  //   fetch('http://…​.invalid')       -> same shape, e.cause.code === 'ENOTFOUND'
  //
  // Reading `e.code` alone therefore made this branch DEAD on the only path it exists for, and an
  // engine-down launch fell through to AMBIGUOUS. That is not a harmless deferral: the AMBIGUOUS branch
  // frees `activeKey`, and `reconcileStaleActive` only ever queries `activeKey: ACTIVE_KEY` — so nothing
  // ever settles the run again and its CONSUMED message is stranded FOREVER, silently. Undici also nests
  // (and may wrap several attempts in an `AggregateError`), so walk the chain rather than peeking one
  // level down.
  if (hasPreSpawnSyscallCode(err)) return 'PRE_SPAWN';
  // A 4xx is the engine itself rejecting the request — it parsed it and declined, so no run was spawned.
  if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) return 'PRE_SPAWN';
  return 'AMBIGUOUS';
}

/**
 * Settle a CONSUMED message into exactly one terminal state, at most once.
 *
 * The conditional update on `systemMessageState: 'CONSUMED'` is what makes that deterministic rather than
 * aspirational: reconciliation and the engine's own callback can both fire for the same run, and the row
 * count elects a single winner.
 *
 * Returns true when the message was put back on the session.
 */
async function transitionConsumed(
  tx: Prisma.TransactionClient,
  run: ConsumedRun,
  extraRunData: Record<string, unknown>,
  desired: SettledState,
): Promise<boolean> {
  if (run.systemMessageState !== 'CONSUMED' || run.systemMessageText === null) return false;

  // Elect the single settler for THIS run first. The row count is what makes "at most once" real when
  // reconciliation and the engine's own callback both fire.
  const res = await tx.knowledgeChatRun.updateMany({
    where: { id: run.id, systemMessageState: 'CONSUMED' },
    data: { ...extraRunData, systemMessageState: desired },
  });
  if (res.count === 0) return false; // somebody else already settled it

  if (desired !== 'RESTORED') return false;

  // ⚠️ THE SLOT IS CLAIMED CONDITIONALLY — never read-then-write.
  //
  // "A newer message wins the slot" was previously decided by a plain `findUnique` followed by an
  // UNCONDITIONAL `update`. Those are two statements with a gap between them, and the gap is writable:
  //
  //   1. this transaction reads the slot and sees it empty       -> decides RESTORED
  //   2. a decline (or another proposal's failure) commits a NEWER message into the slot
  //   3. this transaction overwrites it with the OLDER message
  //
  // The newer notification is then lost for good — the exact inversion of the rule the read was meant to
  // enforce. `updateMany ... where pendingSystemMessage: null` closes it: the guard and the write are ONE
  // statement, it takes a row lock so concurrent settlers serialise, and the affected-row count reports
  // which of them won. Zero rows means a newer message is already there, so THIS one is DROPPED.
  //
  // The proposal id travels WITH its text — a restored message that lost what it refers to is a nudge
  // about nothing.
  const claimed = await tx.knowledgeChatSession.updateMany({
    where: { id: run.sessionId, pendingSystemMessage: null },
    data: {
      pendingSystemMessage: run.systemMessageText,
      pendingSystemMessageProposalId: run.systemMessageProposalId,
    },
  });
  if (claimed.count === 1) return true;

  // Lost the slot to a newer message. The run was already marked RESTORED above, so correct it — the run
  // row must not claim a delivery that did not happen.
  await tx.knowledgeChatRun.update({ where: { id: run.id }, data: { systemMessageState: 'DROPPED' } });
  logger.warn(`system message for run ${run.id} DROPPED (slot occupied): ${run.systemMessageText}`);
  return false;
}

/**
 * A CONFIRMED pre-spawn launch failure. The restore MUST happen in the same transaction that marks the run
 * FAILED and frees `activeKey` — otherwise a run admitted in between starts without the message and the
 * restore lands on a later run instead (spec 5.5.4).
 */
export async function restoreOnPreSpawnFailure(
  tx: Prisma.TransactionClient,
  runId: string,
  error: string,
): Promise<void> {
  const run = (await tx.knowledgeChatRun.findUnique({ where: { id: runId } })) as ConsumedRun | null;
  if (!run) return;
  const terminal = { status: 'FAILED' as const, activeKey: null, error, finishedAt: new Date() };
  const settled = await transitionConsumed(tx, run, terminal, 'RESTORED');
  if (!settled) {
    // Either the run carried no message at all (by far the common case — most launches do not), or
    // someone else already settled it. Either way the run itself still has to be marked FAILED and its
    // active slot freed, or the session stays blocked forever.
    await tx.knowledgeChatRun.updateMany({
      where: { id: runId, activeKey: { not: null } },
      data: terminal,
    });
  }
}

/**
 * Reconciliation. Called when a run carrying a CONSUMED message is settled: if it produced no agent turn
 * the message goes back on the session; otherwise it was DELIVERED and stays delivered.
 *
 * A missing nudge is a far smaller defect than a duplicated system message, which the agent would read as
 * a second refusal for the same proposal.
 */
export async function settleConsumedMessage(
  tx: Prisma.TransactionClient,
  run: ConsumedRun,
  info: { producedAgentTurn: boolean },
): Promise<void> {
  await transitionConsumed(tx, run, {}, info.producedAgentTurn ? 'DELIVERED' : 'RESTORED');
}
