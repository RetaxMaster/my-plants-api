import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from '../owner/owner.service.js';
import { ProgressService } from './progress.service.js';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const actor = (ownerId: string) => ({ userId: 'u', username: 'n', ownerId, role: 'USER' as const, jti: 'j', exp: 9e9 });

function setup() {
  const entries = [
    // photoCount now counts READY photos only (spec §5.2): e1 has 2 READY + 1 PROCESSING → photoCount 2,
    // processingCount 1. e2 has no photos.
    { id: 'e1', plantId: 'p1', occurredOn: d('2026-07-01'), health: 'GOOD', tags: ['PESTS'], createdAt: d('2026-07-01'), photos: [{ status: 'READY' }, { status: 'READY' }, { status: 'PROCESSING' }] },
    { id: 'e2', plantId: 'p1', occurredOn: d('2026-06-15'), health: 'EXCELLENT', tags: null, createdAt: d('2026-06-15'), photos: [] },
  ];
  // Only DONE actions in the six-task allowlist should surface. The service query is expected to
  // already filter (type DONE + task in allowlist); the fake honors that filter so the test asserts it.
  const allEvents = [
    { task: 'WATER', type: 'DONE', occurredOn: d('2026-06-29'), createdAt: d('2026-06-29') },
    { task: 'FERTILIZE', type: 'DONE', occurredOn: d('2026-06-10'), createdAt: d('2026-06-10') },
    { task: 'PROGRESS', type: 'DONE', occurredOn: d('2026-07-01'), createdAt: d('2026-07-01') }, // excluded (progress-as-action)
    { task: 'WATER', type: 'POSTPONED', occurredOn: d('2026-06-28'), createdAt: d('2026-06-28') }, // excluded
    { task: 'WATER', type: 'SYMPTOM', occurredOn: d('2026-06-20'), createdAt: d('2026-06-20') }, // excluded
  ];
  const prisma = {
    plant: { findFirst: async ({ where }: any) => (where.id === 'p1' && (where.ownerId === undefined || where.ownerId === 'owner-1') ? { id: 'p1' } : null) },
    plantProgressEntry: { findMany: async () => entries },
    careEvent: {
      findMany: async ({ where }: any) =>
        allEvents.filter((e) => e.type === where.type && where.task.in.includes(e.task)),
    },
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new ProgressService(prisma, owner, {} as any, {} as any, {} as any, {} as any);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run };
}

describe('ProgressService.history', () => {
  it('merges progress + DONE actions, reverse-chronological, excluding PROGRESS-as-action / POSTPONED / SYMPTOM', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1'), async () => {
      const feed = await svc.history('p1');
      expect(feed.map((i: any) => (i.kind === 'progress' ? `progress:${i.entryId}` : `action:${i.task}`)))
        .toEqual(['progress:e1', 'action:WATER', 'progress:e2', 'action:FERTILIZE']);
      const progress = feed.find((i: any) => i.entryId === 'e1');
      expect(progress).toMatchObject({ kind: 'progress', health: 'GOOD', photoCount: 2, tagCount: 1, occurredOn: '2026-07-01' });
      const action = feed.find((i: any) => i.kind === 'action' && i.task === 'WATER');
      expect(action).toMatchObject({ kind: 'action', type: 'DONE', occurredOn: '2026-06-29' });
    });
  });

  it('is owner-scoped (unknown/foreign plant → 404)', async () => {
    const { svc, run } = setup();
    await run({ ...actor('owner-1'), ownerId: 'owner-2' }, async () => {
      await expect(svc.history('p1')).rejects.toThrow();
    });
  });
});
