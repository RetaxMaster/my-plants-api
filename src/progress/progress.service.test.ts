import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { ProgressService } from './progress.service.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN' = 'USER') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });
const file = (name: string) => ({ buffer: Buffer.from(name), originalname: name }) as Express.Multer.File;

function setup(opts: { uploadThrowsOn?: number } = {}) {
  const created: any[] = [];
  const events: any[] = [];
  const deleted: string[] = [];
  const recomputed: string[] = [];
  let uploadCount = 0;

  const plant = {
    id: 'p1', ownerId: 'owner-1',
    place: { city: { timezone: 'America/Mexico_City' } },
  };

  const tx = {
    plantProgressEntry: {
      create: async ({ data }: any) => { const row = { id: 'entry-1', ...data }; created.push(row); return row; },
    },
    careEvent: { create: async ({ data }: any) => { events.push(data); } },
  };

  const prisma = {
    plant: {
      findFirst: async ({ where }: any) =>
        where.id === 'p1' && (where.ownerId === undefined || where.ownerId === 'owner-1') ? plant : null,
    },
    plantProgressEntry: {
      findFirst: async ({ where }: any) =>
        where.id === 'entry-1' ? { id: 'entry-1', plantId: 'p1', occurredOn: new Date(Date.UTC(2026, 6, 2)), health: 'GOOD', observations: 'ok', sizeCm: 12, tags: ['PESTS'], photos: [{ id: 'ph1', imageUrl: 'https://cdn/x.webp', sortOrder: 0 }] } : null,
    },
    $transaction: async (fn: any) => fn(tx),
  } as any;

  const images = {
    upload: vi.fn(async () => {
      uploadCount += 1;
      if (opts.uploadThrowsOn === uploadCount) throw new Error('image_decode_failed');
      return { imageUrl: `https://cdn/${uploadCount}.webp`, imageObjectKey: `plants/p1/progress/${uploadCount}.webp` };
    }),
    delete: vi.fn(async (key: string) => { deleted.push(key); }),
  } as any;

  const carePlan = { recomputePlant: async (id: string) => { recomputed.push(id); } } as any;

  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new ProgressService(prisma, owner, images, carePlan);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, created, events, deleted, recomputed, images };
}

describe('ProgressService.create', () => {
  it('uploads photos, writes entry + photos + DONE PROGRESS CareEvent, then recomputes after commit', async () => {
    const { svc, run, created, events, recomputed } = setup();
    await run(actor('owner-1'), async () => {
      const out = await svc.create('p1', { health: 'GOOD' } as any, [file('a'), file('b')]);
      expect(out.id).toBe('entry-1');
    });
    expect(created).toHaveLength(1);
    expect(created[0].photos.create).toHaveLength(2);
    expect(events).toEqual([expect.objectContaining({ task: 'PROGRESS', type: 'DONE' })]);
    expect(recomputed).toEqual(['p1']);
  });

  it('defaults occurredOn to today in the plant place-city timezone (a native UTC Date)', async () => {
    const { svc, run, created } = setup();
    await run(actor('owner-1'), async () => { await svc.create('p1', { health: 'GOOD' } as any, []); });
    expect(created[0].occurredOn).toBeInstanceOf(Date);
    expect(created[0].occurredOn.getUTCHours()).toBe(0); // DATE granularity
  });

  it('rejects an unknown tag with 400 and never uploads or writes', async () => {
    const { svc, run, created, images } = setup();
    await run(actor('owner-1'), async () => {
      await expect(svc.create('p1', { health: 'GOOD', tags: '["NOPE"]' } as any, [file('a')]))
        .rejects.toBeInstanceOf(BadRequestException);
    });
    expect(images.upload).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("can't post to another owner's plant → 404", async () => {
    const { svc, run } = setup();
    await run(actor('owner-2'), async () => {
      await expect(svc.create('p1', { health: 'GOOD' } as any, [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('a failed image aborts with no DB row and deletes every already-uploaded object (no orphans)', async () => {
    const { svc, run, created, deleted } = setup({ uploadThrowsOn: 2 }); // first upload ok, second throws
    await run(actor('owner-1'), async () => {
      await expect(svc.create('p1', { health: 'GOOD' } as any, [file('a'), file('b')])).rejects.toThrow();
    });
    expect(created).toHaveLength(0);
    expect(deleted).toEqual(['plants/p1/progress/1.webp']); // the one that had succeeded
  });
});

describe('ProgressService.getEntry', () => {
  it('returns the entry with resolved tags + ordered photos (owner-scoped)', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1'), async () => {
      const e = await svc.getEntry('p1', 'entry-1');
      expect(e.tags).toEqual([{ key: 'PESTS', label: 'Pests', group: 'negative' }]);
      expect(e.photos[0].imageUrl).toBe('https://cdn/x.webp');
      expect(e.occurredOn).toBe('2026-07-02');
    });
  });
});
