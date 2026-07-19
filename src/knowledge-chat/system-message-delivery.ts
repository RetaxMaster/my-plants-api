import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
export function classifyLaunchFailure(err: unknown): LaunchFailureClass {
  const e = (err ?? {}) as { code?: string; status?: number };
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') return 'PRE_SPAWN';
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

  // A newer message wins the slot; the older one is DROPPED rather than overwriting it.
  let final: SettledState = desired;
  if (desired === 'RESTORED') {
    const session = await tx.knowledgeChatSession.findUnique({ where: { id: run.sessionId } });
    if (session?.pendingSystemMessage) final = 'DROPPED';
  }

  const res = await tx.knowledgeChatRun.updateMany({
    where: { id: run.id, systemMessageState: 'CONSUMED' },
    data: { ...extraRunData, systemMessageState: final },
  });
  if (res.count === 0) return false; // somebody else already settled it

  if (final === 'RESTORED') {
    await tx.knowledgeChatSession.update({
      where: { id: run.sessionId },
      // The proposal id travels WITH its text — a restored message that lost what it refers to is a
      // nudge about nothing.
      data: {
        pendingSystemMessage: run.systemMessageText,
        pendingSystemMessageProposalId: run.systemMessageProposalId,
      },
    });
    return true;
  }
  if (final === 'DROPPED') {
    logger.warn(`system message for run ${run.id} DROPPED (slot occupied): ${run.systemMessageText}`);
  }
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
