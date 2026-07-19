import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The right to spawn is a LEASE, not a check (spec §8.1).
 *
 * A re-read before `launch()` is not enough on its own: between that read and the `/execute` POST there is
 * real async work — workspace preparation, token minting, ticket issue — during which a deploy can drain
 * and cancel the run. Only a run holding the `LAUNCHING` lease may call `/execute`.
 *
 * The claim leads and the verification read follows, INSIDE the same transaction. That order is the whole
 * mechanism: the claim is what makes the run's state unambiguous to the drain, and reading the record
 * first would simply widen the window the lease exists to close.
 *
 * Returns true iff the caller now holds the lease and may spawn.
 */
export async function takeLaunchLease(
  prisma: PrismaService,
  runId: string,
  readVerified: () => Promise<boolean>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.knowledgeChatRun.updateMany({
      // ONLY a QUEUED run may be leased. Claiming any active status would let a RUNNING run be re-leased
      // and spawned a second time.
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'LAUNCHING' },
    });
    if (claimed.count === 0) return false;
    // Re-read the verification record inside the SAME transaction as the claim.
    return readVerified();
  });
}

/*
 * Why there is no SECOND re-read after this transaction commits.
 *
 * A reviewer will ask; the answer is that the lease plus the drain's `LAUNCHING` handling already close
 * the window, and a post-commit re-read would add nothing. Once this returns `true` the row is
 * `LAUNCHING`, and the drain (deploy plan) NEVER cancels-and-forgets a `LAUNCHING` run — it WAITS for it
 * to resolve into `RUNNING` (identity recorded, so the drain can then confirm the process) or into a
 * terminal state. So a `false` written after the lease is granted does not strand a process: the drain
 * blocks on it. That is exactly spec §8.1's guarantee — a run is either pre-lease (no process can ever
 * exist) or post-lease (its identity is recorded and the drain can wait for it). Adding a re-read after
 * commit would create a THIRD state — leased but refused — that nothing waits on, which is strictly worse.
 */
