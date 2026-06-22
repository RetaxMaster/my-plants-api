import { describe, expect, it, vi } from 'vitest';
import { MovingService } from './moving.service.js';

// applyAllDueMoves is an owner-AGNOSTIC system job (cron / startup). It must:
//  - iterate every owner,
//  - apply each owner's due moves scoped to that owner,
//  - recompute the whole garden exactly once at the end (only if any move applied),
//  - and NEVER read the CLS actor (it runs outside any cls.run — no OwnerService call).
function makeService() {
  const owners = [{ id: 'owner-1' }, { id: 'owner-2' }];
  const moves = [
    { id: 'm1', ownerId: 'owner-1', targetCityId: 'c1', applied: false, moveOn: new Date('2026-06-01') },
    { id: 'm2', ownerId: 'owner-2', targetCityId: 'c2', applied: false, moveOn: new Date('2026-06-01') },
  ];
  const txOps: string[] = [];
  const tx = {
    city: {
      findFirst: vi.fn(async () => null), // no current primary in-tx → no-primary fallback (all outdoor places)
      updateMany: vi.fn(async () => { txOps.push('city.updateMany'); return { count: 0 }; }),
      update: vi.fn(async () => { txOps.push('city.update'); return {}; }),
    },
    place: { updateMany: vi.fn(async () => { txOps.push('place.updateMany'); return { count: 0 }; }) },
    scheduledMove: {
      update: vi.fn(async ({ where }: any) => {
        const m = moves.find((x) => x.id === where.id)!;
        m.applied = true;
        txOps.push('scheduledMove.update');
        return m;
      }),
    },
  };
  const prisma = {
    owner: { findMany: vi.fn(async () => owners) },
    city: { findFirst: vi.fn(async () => null) }, // no primary city → UTC cutoff
    scheduledMove: {
      findMany: vi.fn(async ({ where }: any) =>
        moves.filter((m) => m.ownerId === where.ownerId && !m.applied && m.moveOn < where.moveOn.lt),
      ),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as unknown as ConstructorParameters<typeof MovingService>[0];

  // The OwnerService must NEVER be touched by the all-owners job; make every method throw to prove it.
  const owner = {
    currentOwnerId: () => { throw new Error('actor read in a system job'); },
    currentRole: () => { throw new Error('actor read in a system job'); },
    ownerFilter: () => { throw new Error('actor read in a system job'); },
  } as unknown as ConstructorParameters<typeof MovingService>[1];
  const weather = {} as ConstructorParameters<typeof MovingService>[2];
  const recomputeAll = vi.fn(async () => {});
  const carePlan = { recomputeAll } as unknown as ConstructorParameters<typeof MovingService>[3];

  const svc = new MovingService(prisma, owner, weather, carePlan);
  return { svc, prisma, recomputeAll, moves };
}

describe('MovingService.applyAllDueMoves (owner-agnostic system job)', () => {
  it('applies due moves for EVERY owner and recomputes once — without reading the actor', async () => {
    const { svc, recomputeAll, moves } = makeService();
    // Called OUTSIDE any cls.run: if it touched OwnerService it would throw.
    const total = await svc.applyAllDueMoves(new Date('2026-06-21'));
    expect(total).toBe(2);
    expect(moves.every((m) => m.applied)).toBe(true);
    expect(recomputeAll).toHaveBeenCalledTimes(1);
  });

  it('does not recompute when there are no due moves', async () => {
    const { svc, recomputeAll, moves } = makeService();
    moves.forEach((m) => (m.applied = true)); // nothing due
    const total = await svc.applyAllDueMoves(new Date('2026-06-21'));
    expect(total).toBe(0);
    expect(recomputeAll).not.toHaveBeenCalled();
  });
});
