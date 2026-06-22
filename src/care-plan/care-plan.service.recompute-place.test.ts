import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

it('recomputePlace recomputes every plant in the place', async () => {
  const recomputed: string[] = [];
  const prisma = { plant: { findMany: async ({ where }: any) => where.placeId === 'p1' ? [{ id: 'a' }, { id: 'b' }] : [] } } as any;
  const svc = new CarePlanService(prisma, {} as any);
  // Stub the per-plant recompute so this test stays unit-scoped.
  (svc as any).recomputePlant = async (id: string) => { recomputed.push(id); };
  await svc.recomputePlace('p1');
  expect(recomputed).toEqual(['a', 'b']);
});
