import { describe, expect, it, vi } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

// reconcileProgressEventPairing (spec §3.3): pair a null-FK PROGRESS event to its (plantId, occurredOn) entry,
// prune the genuinely unpairable, and no-op when there are no orphans. A minimal fake prisma exposes only the
// four calls the method makes.
function setup(opts: { orphans: any[]; entryFor: (ev: any) => any }) {
  const updated: { id: string; progressEntryId: string }[] = [];
  const deleted: string[] = [];
  let findManyCalls = 0;
  const prisma = {
    careEvent: {
      findMany: vi.fn(async () => { findManyCalls += 1; return opts.orphans; }),
      update: vi.fn(async ({ where, data }: any) => { updated.push({ id: where.id, progressEntryId: data.progressEntryId }); }),
      delete: vi.fn(async ({ where }: any) => { deleted.push(where.id); }),
    },
    plantProgressEntry: {
      findFirst: vi.fn(async ({ where }: any) => opts.entryFor(where)),
    },
  } as any;
  const svc = new CarePlanService(prisma, {} as any);
  return { svc, prisma, updated, deleted, get findManyCalls() { return findManyCalls; } };
}

describe('CarePlanService.reconcileProgressEventPairing (spec §3.3)', () => {
  it('pairs a null-FK PROGRESS event to its (plantId, occurredOn) entry', async () => {
    const ev = { id: 'ev1', plantId: 'p1', occurredOn: new Date(Date.UTC(2026, 6, 1)) };
    const { svc, updated, deleted } = setup({
      orphans: [ev],
      entryFor: (w) => (w.plantId === 'p1' ? { id: 'entry-1', createdAt: new Date() } : null),
    });
    await svc.reconcileProgressEventPairing();
    expect(updated).toEqual([{ id: 'ev1', progressEntryId: 'entry-1' }]);
    expect(deleted).toEqual([]);
  });

  it('prunes an unpairable PROGRESS event (no matching entry)', async () => {
    const ev = { id: 'evX', plantId: 'p1', occurredOn: new Date(Date.UTC(2026, 6, 9)) };
    const { svc, updated, deleted } = setup({ orphans: [ev], entryFor: () => null });
    await svc.reconcileProgressEventPairing();
    expect(updated).toEqual([]);
    expect(deleted).toEqual(['evX']); // stray deleted, not left as a null-FK straggler
  });

  it('no-ops (does not scan for entries) when there are no null-FK PROGRESS events', async () => {
    const { svc, prisma } = setup({ orphans: [], entryFor: () => null });
    await svc.reconcileProgressEventPairing();
    expect(prisma.plantProgressEntry.findFirst).not.toHaveBeenCalled(); // idempotent fast path
  });
});
