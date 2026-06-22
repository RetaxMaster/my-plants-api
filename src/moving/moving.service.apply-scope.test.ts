import { describe, expect, it } from 'vitest';
import { MovingService } from './moving.service.js';

describe('MovingService.applyDueMovesForOwner scoping', () => {
  it('repoints only the old-primary city outdoor places, resolved inside the move tx', async () => {
    const placeUpdateCalls: any[] = [];
    const moves = [{ id: 'm1', targetCityId: 'c2', applied: false, moveOn: new Date('2026-06-01') }];
    const tx = {
      city: {
        findFirst: async ({ where }: any) => (where.isPrimary ? { id: 'c1', timezone: 'UTC' } : null), // current primary
        updateMany: async () => ({ count: 1 }),
        update: async () => ({}),
      },
      place: { updateMany: async ({ where }: any) => { placeUpdateCalls.push(where); return { count: 1 }; } },
      scheduledMove: { update: async () => ({}) },
    };
    const prisma = {
      city: { findFirst: async ({ where }: any) => (where.isPrimary ? { id: 'c1', timezone: 'UTC' } : null) },
      scheduledMove: { findMany: async () => moves },
      $transaction: async (fn: any) => fn(tx),
    } as any;
    const svc = new MovingService(prisma, {} as any, {} as any, {} as any);
    const n = await svc.applyDueMovesForOwner('o1', new Date('2026-06-21T12:00:00Z'));
    expect(n).toBe(1);
    expect(placeUpdateCalls).toEqual([{ ownerId: 'o1', indoor: false, cityId: 'c1' }]);
  });

  it('a chain of due moves repoints the right places per move (old primary resolved inside each tx)', async () => {
    let currentPrimary = 'c1';
    const placeUpdateCalls: any[] = [];
    const moves = [
      { id: 'm1', targetCityId: 'c2', applied: false, moveOn: new Date('2026-06-01') },
      { id: 'm2', targetCityId: 'c3', applied: false, moveOn: new Date('2026-06-02') },
    ];
    const tx = {
      city: {
        findFirst: async ({ where }: any) => (where.isPrimary ? { id: currentPrimary, timezone: 'UTC' } : null),
        updateMany: async () => ({ count: 1 }),
        update: async ({ where, data }: any) => { if (data.isPrimary) currentPrimary = where.id; return {}; },
      },
      place: { updateMany: async ({ where }: any) => { placeUpdateCalls.push(where); return { count: 1 }; } },
      scheduledMove: { update: async () => ({}) },
    };
    const prisma = {
      city: { findFirst: async ({ where }: any) => (where.isPrimary ? { id: currentPrimary, timezone: 'UTC' } : null) },
      scheduledMove: { findMany: async () => moves },
      $transaction: async (fn: any) => fn(tx),
    } as any;
    const svc = new MovingService(prisma, {} as any, {} as any, {} as any);
    const n = await svc.applyDueMovesForOwner('o1', new Date('2026-06-21T12:00:00Z'));
    expect(n).toBe(2);
    // m1 moves c1's outdoor places to c2; m2 then moves c2's outdoor places to c3.
    expect(placeUpdateCalls).toEqual([
      { ownerId: 'o1', indoor: false, cityId: 'c1' },
      { ownerId: 'o1', indoor: false, cityId: 'c2' },
    ]);
  });
});
