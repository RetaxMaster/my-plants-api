import { describe, it, expect, vi } from 'vitest';
import { takeLaunchLease } from './launch-lease.js';
import { ACTIVE_RUN_STATUSES } from './run-status.js';

const prismaWith = (count: number) => {
  // The parameter is typed deliberately: an untyped `vi.fn(async () => …)` gives `mock.calls` the type
  // `[]`, and indexing it fails to compile (typecheck covers `src/**/*.test.ts`).
  const updateMany = vi.fn(async (_args: { where: unknown; data: unknown }) => ({ count }));
  return {
    prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ knowledgeChatRun: { updateMany } })) },
    updateMany,
  };
};

describe('takeLaunchLease', () => {
  it('grants the lease when QUEUED -> LAUNCHING affects one row and the record reads true', async () => {
    const { prisma } = prismaWith(1);
    expect(await takeLaunchLease(prisma as never, 'r1', async () => true)).toBe(true);
  });

  it('refuses when the conditional update affects 0 rows (the run was cancelled meanwhile)', async () => {
    const { prisma } = prismaWith(0);
    expect(await takeLaunchLease(prisma as never, 'r1', async () => false)).toBe(false);
  });

  it('refuses when the verification record reads false in the SAME transaction', async () => {
    const { prisma } = prismaWith(1);
    expect(await takeLaunchLease(prisma as never, 'r1', async () => true)).toBe(true);
    const second = prismaWith(1);
    expect(await takeLaunchLease(second.prisma as never, 'r1', async () => false)).toBe(false);
  });

  it('claims ONLY a QUEUED run, and moves it to LAUNCHING', async () => {
    // The precondition is the lease. If this claimed any active status, a RUNNING run could be
    // re-leased and spawned twice.
    const { prisma, updateMany } = prismaWith(1);
    await takeLaunchLease(prisma as never, 'r1', async () => true);
    expect(updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'r1', status: 'QUEUED' },
      data: { status: 'LAUNCHING' },
    });
  });

  it('does not read the verification record at all when the claim was already lost', async () => {
    // Order matters: claim first, then verify. Reading first would widen the window the lease exists
    // to close.
    const { prisma } = prismaWith(0);
    const readVerified = vi.fn(async () => true);
    await takeLaunchLease(prisma as never, 'r1', readVerified);
    expect(readVerified).not.toHaveBeenCalled();
  });

  // Spec §10: "a run admitted during the drain window is terminated before spawn (the §8.1
  // compare-after-commit)". This is THE test that proves the lease is a lease and not a check.
  it('a run admitted during the drain window never spawns', async () => {
    const execute = vi.fn();
    // The deploy has already written the record false and is draining. The run was admitted just before
    // that write, so it is still QUEUED and its conditional update WILL affect a row — the record read
    // inside the same transaction is what refuses it.
    const { prisma } = prismaWith(1);
    const leased = await takeLaunchLease(prisma as never, 'r1', async () => false);
    if (leased) await execute();
    expect(leased).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  // The other half of the window: the drain cancelled the run out of QUEUED before it got here.
  it('a run cancelled by the drain never spawns even though the record still reads true', async () => {
    const execute = vi.fn();
    const { prisma } = prismaWith(0);
    const leased = await takeLaunchLease(prisma as never, 'r1', async () => true);
    if (leased) await execute();
    expect(leased).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('the active-run status vocabulary', () => {
  it('is exactly QUEUED, LAUNCHING, RUNNING — the deploy drain mirrors these literals in raw SQL', () => {
    // Phase 6's drain cannot import this constant (it is shell + raw SQL, deliberately decoupled from the
    // generated Prisma enum), so it hard-codes these literals. Pinning them here is what makes that
    // duplication safe: if a status is added or renamed, this fails and names the drain as the sibling
    // that must change in the same edit.
    expect([...ACTIVE_RUN_STATUSES]).toEqual(['QUEUED', 'LAUNCHING', 'RUNNING']);
  });

  it('includes LAUNCHING, so a leased run still holds the session active slot', () => {
    // A LAUNCHING run left out of this list would look idle: a second turn could be admitted while the
    // first is mid-spawn, and the drain would stop waiting for a process that is about to exist.
    expect(ACTIVE_RUN_STATUSES).toContain('LAUNCHING');
  });
});
