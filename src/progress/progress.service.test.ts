import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { ProgressService } from './progress.service.js';
import { ImageUploadError } from '../storage/image-upload.errors.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN' = 'USER') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });
const file = (name: string) => ({ buffer: Buffer.from(name), originalname: name }) as Express.Multer.File;

function setup(opts: { txnThrows?: boolean; capacityThrows?: boolean; entryPhotos?: any[] } = {}) {
  const created: any[] = [];
  const events: any[] = [];
  const recomputed: string[] = [];
  const staged: { inboxPath: string; originalName: string; sizeBytes: number }[] = [];
  const stagedDeleted: string[] = [];
  let nudged = 0;

  const plant = {
    id: 'p1', ownerId: 'owner-1',
    place: { city: { timezone: 'America/Mexico_City' } },
  };

  const tx = {
    plantProgressEntry: {
      create: async ({ data }: any) => {
        if (opts.txnThrows) throw new Error('txn boom');
        const row = { id: 'entry-1', ...data }; created.push(row); return row;
      },
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
        where.id === 'entry-1' ? { id: 'entry-1', plantId: 'p1', occurredOn: new Date(Date.UTC(2026, 6, 2)), health: 'GOOD', observations: 'ok', sizeCm: 12, tags: ['PESTS'], photos: opts.entryPhotos ?? [{ id: 'ph1', status: 'READY', imageUrl: 'https://cdn/x.webp', imageObjectKey: 'k', inboxPath: null, originalName: null, failureKind: null, failureCode: null, sortOrder: 0 }] } : null,
    },
    $transaction: async (fn: any) => fn(tx),
  } as any;

  const images = { upload: vi.fn(async () => { throw new Error('create must NOT call images.upload'); }), delete: vi.fn() } as any;
  const carePlan = { recomputePlant: async (id: string) => { recomputed.push(id); } } as any;

  const inbox = {
    stage: vi.fn(async (fs: { buffer: Buffer; originalName: string }[]) => {
      if (opts.capacityThrows) throw new ImageUploadError('photo_storage_busy', 'busy');
      const s = fs.map((f, i) => ({ inboxPath: `/inbox/${f.originalName}-${i}.bin`, originalName: f.originalName, sizeBytes: f.buffer.length }));
      staged.push(...s); return s;
    }),
    deleteMany: vi.fn(async (paths: string[]) => { stagedDeleted.push(...paths); }),
  } as any;
  const worker = { enqueueTick: vi.fn(() => { nudged += 1; }) } as any;

  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new ProgressService(prisma, owner, images, carePlan, inbox, worker);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, created, events, recomputed, staged, stagedDeleted, images, inbox, worker, get nudged() { return nudged; } };
}

describe('ProgressService.create', () => {
  it('stages files → entry + PENDING photo rows + CareEvent(progressEntryId) in ONE txn, NO R2 call, nudges', async () => {
    const { svc, run, created, events, recomputed, staged, images, worker } = setup();
    await run(actor('owner-1'), async () => {
      const out = await svc.create('p1', { health: 'GOOD' } as any, [file('a'), file('b')]);
      expect(out.id).toBe('entry-1');
    });
    expect(images.upload).not.toHaveBeenCalled(); // NO synchronous R2 upload in the request
    expect(staged).toHaveLength(2); // both files staged to the inbox
    expect(created).toHaveLength(1);
    expect(created[0].photos.create).toHaveLength(2);
    expect(created[0].photos.create[0]).toMatchObject({ status: 'PENDING', sortOrder: 0, originalName: 'a' });
    expect(created[0].photos.create[0].inboxPath).toBeTruthy();
    expect(created[0].photos.create[1].sortOrder).toBe(1);
    expect(events).toEqual([expect.objectContaining({ task: 'PROGRESS', type: 'DONE', progressEntryId: 'entry-1' })]);
    expect(recomputed).toEqual(['p1']);
    expect(worker.enqueueTick).toHaveBeenCalledTimes(1);
  });

  it('defaults occurredOn to today in the plant place-city timezone (a native UTC Date)', async () => {
    const { svc, run, created } = setup();
    await run(actor('owner-1'), async () => { await svc.create('p1', { health: 'GOOD' } as any, []); });
    expect(created[0].occurredOn).toBeInstanceOf(Date);
    expect(created[0].occurredOn.getUTCHours()).toBe(0); // DATE granularity
  });

  it('rejects an unknown tag with 400 and never stages or writes', async () => {
    const { svc, run, created, inbox } = setup();
    await run(actor('owner-1'), async () => {
      await expect(svc.create('p1', { health: 'GOOD', tags: '["NOPE"]' } as any, [file('a')]))
        .rejects.toBeInstanceOf(BadRequestException);
    });
    expect(inbox.stage).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("can't post to another owner's plant → 404", async () => {
    const { svc, run } = setup();
    await run(actor('owner-2'), async () => {
      await expect(svc.create('p1', { health: 'GOOD' } as any, [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('compensates the staged inbox files when the transaction throws', async () => {
    const { svc, run, created, staged, stagedDeleted } = setup({ txnThrows: true });
    await run(actor('owner-1'), async () => {
      await expect(svc.create('p1', { health: 'GOOD' } as any, [file('a')])).rejects.toThrow();
    });
    expect(created).toHaveLength(0);
    expect(staged).toHaveLength(1);
    expect(stagedDeleted).toEqual(staged.map((s) => s.inboxPath)); // the staged file was compensated
  });

  it('capacity guard: inbox.stage throwing photo_storage_busy propagates as-is (503), nothing persisted', async () => {
    const { svc, run, created, staged } = setup({ capacityThrows: true });
    await run(actor('owner-1'), async () => {
      await expect(svc.create('p1', { health: 'GOOD' } as any, [file('a')]))
        .rejects.toMatchObject({ code: 'photo_storage_busy' });
    });
    expect(created).toHaveLength(0);
    expect(staged).toHaveLength(0);
  });

  it('a text-only save (no files) creates the entry + CareEvent and does not stage anything', async () => {
    const { svc, run, created, events, staged, inbox } = setup();
    await run(actor('owner-1'), async () => { await svc.create('p1', { health: 'GOOD' } as any, []); });
    expect(inbox.stage).not.toHaveBeenCalled();
    expect(staged).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ task: 'PROGRESS', type: 'DONE', progressEntryId: 'entry-1' })]);
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

describe('ProgressService.getEntry — per-photo read shape (spec §5.2)', () => {
  const mixed = [
    { id: 'r', status: 'READY', imageUrl: 'https://cdn/r.webp', imageObjectKey: 'k', inboxPath: null, originalName: 'r.jpg', failureKind: null, failureCode: null, sortOrder: 0 },
    { id: 'p', status: 'PROCESSING', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/p.bin', originalName: 'p.jpg', failureKind: null, failureCode: null, sortOrder: 1 },
    { id: 'ft', status: 'FAILED', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ft.bin', originalName: 'ft.jpg', failureKind: 'transient', failureCode: 'upload_failed', sortOrder: 2 },
    { id: 'fp', status: 'FAILED', imageUrl: null, imageObjectKey: null, inboxPath: null, originalName: 'fp.jpg', failureKind: 'permanent', failureCode: 'image_too_large', sortOrder: 3 },
  ];

  it('projects imageUrl null for non-READY, failureCode, retryable, and rollups', async () => {
    const { svc, run } = setup({ entryPhotos: mixed });
    await run(actor('owner-1'), async () => {
      const e: any = await svc.getEntry('p1', 'entry-1');
      const byId = Object.fromEntries(e.photos.map((p: any) => [p.id, p]));
      expect(byId.r.imageUrl).toBe('https://cdn/r.webp');
      expect(byId.p.imageUrl).toBeNull();   // non-READY → null, never the empty string
      expect(byId.ft.imageUrl).toBeNull();
      expect(byId.ft.retryable).toBe(true);  // transient + inbox present
      expect(byId.fp.retryable).toBe(false); // permanent
      expect(byId.ft.failureCode).toBe('upload_failed');
      expect(e.processingCount).toBe(1);     // PROCESSING/PENDING/RECOVERING
      expect(e.failedCount).toBe(2);
    });
  });

  it('retryable is FALSE for a transient FAILED photo whose inboxPath was reclaimed (bytes gone)', async () => {
    const reclaimed = [{ id: 'x', status: 'FAILED', imageUrl: null, imageObjectKey: null, inboxPath: null, originalName: 'x.jpg', failureKind: 'transient', failureCode: 'upload_failed', sortOrder: 0 }];
    const { svc, run } = setup({ entryPhotos: reclaimed });
    await run(actor('owner-1'), async () => {
      const e: any = await svc.getEntry('p1', 'entry-1');
      expect(e.photos[0].retryable).toBe(false); // transient but inboxPath null → not retryable
    });
  });
});
