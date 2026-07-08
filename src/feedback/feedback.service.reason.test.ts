import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { FeedbackService } from './feedback.service.js';

// Minimal owner service: USER owns any plant we look up (the reason path isn't about ownership here; a
// dedicated ownership test is below).
function build(opts: { owned?: boolean } = {}) {
  const created: any[] = [];
  const adjustmentUpserts: any[] = [];
  const prisma = {
    plant: {
      findFirst: async () => (opts.owned === false ? null : { id: 'pl1' }),
      findUniqueOrThrow: async () => ({ acquiredOn: new Date('2026-06-01') }),
    },
    careEvent: {
      findFirst: async () => null,
      create: async ({ data }: any) => { created.push(data); },
      count: async () => 0, // non-water Postpone adapt() counts recent postpones (0 → still nudges)
    },
    dueCache: { findUnique: async () => ({ nextDueOn: new Date('2026-06-20') }) },
    taskOverride: { count: async () => 0, deleteMany: async () => {}, upsert: async () => {} },
    plantTaskAdjustment: {
      findUnique: async () => null,
      upsert: async (args: any) => { adjustmentUpserts.push(args); },
    },
  } as any;
  const owner = { ownerFilter: () => ({}) } as any;
  const carePlan = { recomputePlant: vi.fn(async () => {}) } as any;
  const svc = new FeedbackService(prisma, owner, carePlan);
  return { svc, created, adjustmentUpserts, carePlan };
}

describe('FeedbackService — reason capture + reason-gated WATER learning', () => {
  it('persists a top-level reason into CareEvent.payload', async () => {
    const { svc, created } = build();
    await svc.record({
      plantId: 'pl1', task: 'WATER', type: 'DONE', occurredOn: new Date('2026-06-15'), reason: 'dry-soil',
    });
    expect(created).toHaveLength(1);
    expect((created[0].payload as any).reason).toBe('dry-soil');
  });

  it('an early WATER DONE with a reason does NOT write a PlantTaskAdjustment (learning moved to recompute)', async () => {
    const { svc, adjustmentUpserts } = build();
    await svc.record({
      plantId: 'pl1', task: 'WATER', type: 'DONE', occurredOn: new Date('2026-06-15'), reason: 'dry-soil',
    });
    expect(adjustmentUpserts).toEqual([]); // no raw multiplier written for WATER anymore
  });

  it('a WATER POSTPONED with a reason does NOT write a PlantTaskAdjustment either', async () => {
    const { svc, adjustmentUpserts } = build();
    await svc.record({
      plantId: 'pl1', task: 'WATER', type: 'POSTPONED', occurredOn: new Date('2026-06-15'),
      postponeToOn: new Date('2026-06-18'), reason: 'soil-still-moist',
    });
    expect(adjustmentUpserts).toEqual([]);
  });

  it('a NON-water POSTPONED still adapts its PlantTaskAdjustment (unchanged behaviour)', async () => {
    const { svc, adjustmentUpserts } = build();
    await svc.record({
      plantId: 'pl1', task: 'FERTILIZE', type: 'POSTPONED', occurredOn: new Date('2026-06-15'),
      postponeToOn: new Date('2026-06-25'),
    });
    expect(adjustmentUpserts).toHaveLength(1);
    expect(adjustmentUpserts[0].where.plantId_task.task).toBe('FERTILIZE');
  });

  it('always recomputes the plant after recording', async () => {
    const { svc, carePlan } = build();
    await svc.record({ plantId: 'pl1', task: 'WATER', type: 'DONE', occurredOn: new Date('2026-06-15') });
    expect(carePlan.recomputePlant).toHaveBeenCalledWith('pl1');
  });

  it('rejects a plant the actor does not own', async () => {
    const { svc } = build({ owned: false });
    await expect(
      svc.record({ plantId: 'nope', task: 'WATER', type: 'DONE', occurredOn: new Date('2026-06-15') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
