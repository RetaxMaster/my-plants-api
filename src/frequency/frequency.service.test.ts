import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Task } from '@prisma/client';
import { OwnerService } from '../owner/owner.service.js';
import { FrequencyService } from './frequency.service.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN' = 'USER') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });

function setup() {
  const rows: { plantId: string; task: string; intervalDays: number }[] = [];
  const recomputed: string[] = [];
  const prisma = {
    plant: { findFirst: async ({ where }: any) => (where.id === 'p1' && (where.ownerId === undefined || where.ownerId === 'owner-1') ? { id: 'p1' } : null) },
    plantTaskFrequency: {
      findMany: async ({ where }: any) => rows.filter((r) => r.plantId === where.plantId).map(({ task, intervalDays }) => ({ task, intervalDays })),
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.find((r) => r.plantId === where.plantId_task.plantId && r.task === where.plantId_task.task);
        if (existing) existing.intervalDays = update.intervalDays;
        else rows.push({ plantId: create.plantId, task: create.task, intervalDays: create.intervalDays });
      },
      deleteMany: async ({ where }: any) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].plantId === where.plantId && rows[i].task === where.task) rows.splice(i, 1); },
    },
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const carePlan = { recomputePlant: async (id: string) => { recomputed.push(id); } } as any;
  const svc = new FrequencyService(prisma, owner, carePlan);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, rows, recomputed };
}

describe('FrequencyService', () => {
  it('set upserts and recomputes; list reflects it', async () => {
    const { svc, run, recomputed } = setup();
    await run(actor('owner-1'), async () => {
      const out = await svc.set('p1', { task: Task.WATER, intervalDays: 21 });
      expect(out).toEqual([{ task: 'WATER', intervalDays: 21 }]);
    });
    expect(recomputed).toEqual(['p1']);
  });

  it('clear deletes and recomputes', async () => {
    const { svc, run, recomputed } = setup();
    await run(actor('owner-1'), async () => {
      await svc.set('p1', { task: Task.WATER, intervalDays: 21 });
      const out = await svc.clear('p1', 'WATER');
      expect(out).toEqual([]);
    });
    expect(recomputed).toEqual(['p1', 'p1']);
  });

  it('rejects setting PROGRESS at the service layer, with NO upsert and NO recompute', async () => {
    const { svc, run, rows, recomputed } = setup();
    await run(actor('owner-1'), async () => {
      await expect(svc.set('p1', { task: Task.PROGRESS, intervalDays: 7 })).rejects.toBeInstanceOf(BadRequestException);
    });
    expect(rows).toEqual([]);       // no PlantTaskFrequency row written
    expect(recomputed).toEqual([]); // no recompute triggered
  });

  it('rejects clearing PROGRESS (400)', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1'), async () => {
      await expect(svc.clear('p1', 'PROGRESS')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('rejects clearing an unknown task string (400)', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1'), async () => {
      await expect(svc.clear('p1', 'NONSENSE')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it("a USER cannot touch another owner's plant → 404", async () => {
    const { svc, run } = setup();
    await run(actor('owner-2'), async () => {
      await expect(svc.set('p1', { task: Task.WATER, intervalDays: 10 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
