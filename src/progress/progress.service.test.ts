import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
    // The write core re-checks ownership INSIDE the transaction (it is the applier's boundary too).
    plant: { findFirst: async ({ where }: any) => (where.id === 'p1' && where.ownerId === 'owner-1' ? plant : null) },
    plantWriteAudit: { create: async () => ({}) },
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
      expect(e.tags).toEqual([{ key: 'PESTS', group: 'negative' }]);
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

// ============================================================================================
// CRUD (update/retry/delete) harness — a real, executable in-memory DB + a tiny raw-SQL
// interpreter, mirroring src/photo-worker/__fixtures__/photo-worker-harness.ts's approach (no
// vacuous "the SQL text contains FOR UPDATE" assertions; the fake actually applies each WHERE
// guard against mutable Maps so affected-row counts, sortOrder assignment, etc. are REAL).
//
// Calling convention note: progress.service.ts calls `tx.$queryRaw<T>(Prisma.sql\`...\`)` /
// `tx.$executeRaw(Prisma.sql\`...\`)` — a SINGLE argument that is an already-built Sql object
// (Prisma.sql is a real function at runtime; the object it returns carries `.strings`/`.values`),
// NOT a tagged-template call on $queryRaw itself (that's the OTHER convention the worker harness
// fakes). So here $queryRaw/$executeRaw take one Sql-like argument, not (strings, ...values).
// ============================================================================================
interface SqlLike { strings: readonly string[]; values: unknown[] }
function renderSql(sqlObj: SqlLike): { sql: string; params: unknown[] } {
  let sql = sqlObj.strings[0];
  const params: unknown[] = [];
  for (let i = 0; i < sqlObj.values.length; i++) {
    params.push(sqlObj.values[i]);
    sql += `?${sqlObj.strings[i + 1]}`;
  }
  return { sql: sql.replace(/\s+/g, ' ').trim(), params };
}
const sameTime = (a: Date, b: Date) => a.getTime() === b.getTime();

interface CrudEntry { id: string; plantId: string; occurredOn: Date; health: string; observations: string | null; sizeCm: number | null; tags: unknown; createdAt: Date }
interface CrudPhoto {
  id: string; entryId: string; status: string; imageUrl: string | null; imageObjectKey: string | null;
  inboxPath: string | null; originalName: string | null; claimToken: string | null;
  failureKind: string | null; failureCode: string | null; sortOrder: number; attempts: number; nextAttemptAt: Date | null;
}
interface CrudCareEvent { id: string; plantId: string; task: string; type: string; occurredOn: Date; progressEntryId: string | null }

function setupCrud(opts: {
  ownerId?: string;
  entry?: Partial<CrudEntry>;
  photos?: CrudPhoto[];
  careEvents?: CrudCareEvent[];
  capacityThrows?: boolean;
} = {}) {
  const ownerId = opts.ownerId ?? 'owner-1';
  const plant = { id: 'p1', ownerId, place: { city: { timezone: 'America/Mexico_City' } } };

  const baseOccurredOn = new Date(Date.UTC(2026, 6, 2));
  const entries = new Map<string, CrudEntry>();
  entries.set('entry-1', {
    id: 'entry-1', plantId: 'p1', occurredOn: baseOccurredOn,
    health: 'GOOD', observations: 'ok', sizeCm: 12, tags: ['PESTS'], createdAt: new Date(),
    ...opts.entry,
  });

  const photos = new Map<string, CrudPhoto>();
  const defaultPhotos: CrudPhoto[] = [
    { id: 'ph1', entryId: 'entry-1', status: 'READY', imageUrl: 'https://cdn/1.webp', imageObjectKey: 'k1', inboxPath: null, originalName: 'a.jpg', claimToken: null, failureKind: null, failureCode: null, sortOrder: 0, attempts: 0, nextAttemptAt: null },
    { id: 'ph2', entryId: 'entry-1', status: 'READY', imageUrl: 'https://cdn/2.webp', imageObjectKey: 'k2', inboxPath: null, originalName: 'b.jpg', claimToken: null, failureKind: null, failureCode: null, sortOrder: 1, attempts: 0, nextAttemptAt: null },
  ];
  for (const p of (opts.photos ?? defaultPhotos)) photos.set(p.id, { ...p });

  const careEvents = new Map<string, CrudCareEvent>();
  const defaultCareEvents: CrudCareEvent[] = [
    { id: 'ce1', plantId: 'p1', task: 'PROGRESS', type: 'DONE', occurredOn: entries.get('entry-1')!.occurredOn, progressEntryId: 'entry-1' },
  ];
  for (const ev of (opts.careEvents ?? defaultCareEvents)) careEvents.set(ev.id, { ...ev });

  let seq = 100;
  const nextId = (prefix: string) => `${prefix}${seq++}`;
  const recomputed: string[] = [];
  const staged: { inboxPath: string; originalName: string; sizeBytes: number }[] = [];

  function interpretQuery(sql: string, params: unknown[]): unknown[] {
    if (/FROM plant_progress_entries WHERE id = \? AND plant_id = \? FOR UPDATE/i.test(sql)) {
      const [id, plantId] = params as [string, string];
      const e = entries.get(id);
      if (!e || e.plantId !== plantId) return [];
      return [{ id: e.id, occurred_on: e.occurredOn }];
    }
    if (/JOIN plant_progress_entries e ON e\.id = ph\.entry_id/i.test(sql)) {
      const [photoId, entryId, plantId] = params as [string, string, string];
      const p = photos.get(photoId);
      const e = entries.get(entryId);
      if (!p || p.entryId !== entryId || !e || e.plantId !== plantId) return [];
      return [{ id: p.id, status: p.status, failure_kind: p.failureKind, inbox_path: p.inboxPath }];
    }
    if (/FROM plant_progress_photos WHERE entry_id = \? FOR UPDATE/i.test(sql)) {
      const [entryId] = params as [string];
      return [...photos.values()].filter((p) => p.entryId === entryId)
        .map((p) => ({ id: p.id, status: p.status, claim_token: p.claimToken, image_object_key: p.imageObjectKey, inbox_path: p.inboxPath }));
    }
    throw new Error(`fake $queryRaw: unrecognized SQL: ${sql}`);
  }

  function interpretExecute(sql: string, params: unknown[]): number {
    if (/DELETE FROM plant_progress_photos WHERE id = \? AND entry_id = \?/i.test(sql)) {
      const [id, entryId] = params as [string, string];
      const p = photos.get(id);
      if (p && p.entryId === entryId && ['READY', 'FAILED', 'PENDING'].includes(p.status) && p.claimToken === null) {
        photos.delete(id);
        return 1;
      }
      return 0;
    }
    if (/UPDATE care_events SET occurred_on = \? WHERE progress_entry_id = \?/i.test(sql)) {
      const [newDate, entryId] = params as [Date, string];
      let count = 0;
      for (const ev of careEvents.values()) if (ev.progressEntryId === entryId) { ev.occurredOn = newDate; count += 1; }
      return count;
    }
    if (/UPDATE care_events SET occurred_on = \? WHERE plant_id = \? AND task = 'PROGRESS' AND occurred_on = \? AND progress_entry_id IS NULL LIMIT 1/i.test(sql)) {
      const [newDate, plantId, oldDate] = params as [Date, string, Date];
      for (const [, ev] of careEvents) {
        if (ev.plantId === plantId && ev.task === 'PROGRESS' && ev.progressEntryId === null && sameTime(ev.occurredOn, oldDate)) {
          ev.occurredOn = newDate;
          return 1;
        }
      }
      return 0;
    }
    if (/SET status='PENDING', attempts=0/i.test(sql)) {
      const [photoId] = params as [string];
      const p = photos.get(photoId);
      if (p && p.status === 'FAILED') {
        p.status = 'PENDING'; p.attempts = 0; p.nextAttemptAt = null; p.failureKind = null; p.failureCode = null; p.claimToken = null;
        return 1;
      }
      return 0;
    }
    if (/DELETE FROM care_events WHERE progress_entry_id = \?/i.test(sql)) {
      const [entryId] = params as [string];
      let count = 0;
      for (const [id, ev] of careEvents) if (ev.progressEntryId === entryId) { careEvents.delete(id); count += 1; }
      return count;
    }
    if (/DELETE FROM care_events WHERE plant_id = \?/i.test(sql)) {
      const [plantId, occurredOn] = params as [string, Date];
      for (const [id, ev] of careEvents) {
        if (ev.plantId === plantId && ev.task === 'PROGRESS' && ev.progressEntryId === null && sameTime(ev.occurredOn, occurredOn)) {
          careEvents.delete(id);
          return 1;
        }
      }
      return 0;
    }
    throw new Error(`fake $executeRaw: unrecognized SQL: ${sql}`);
  }

  function makeTx() {
    return {
      $queryRaw: async (sqlObj: SqlLike) => { const { sql, params } = renderSql(sqlObj); return interpretQuery(sql, params); },
      $executeRaw: async (sqlObj: SqlLike) => { const { sql, params } = renderSql(sqlObj); return interpretExecute(sql, params); },
      // The write cores re-check ownership INSIDE the transaction (it is the applier's boundary too).
      plant: { findFirst: async ({ where }: any) => (where.id === 'p1' && where.ownerId === ownerId ? plant : null) },
      plantWriteAudit: { create: async () => ({}) },
      plantProgressPhoto: {
        findMany: async ({ where }: any) =>
          [...photos.values()].filter((p) => p.entryId === where.entryId)
            .map((p) => ({ id: p.id, status: p.status, claimToken: p.claimToken, imageObjectKey: p.imageObjectKey, inboxPath: p.inboxPath, sortOrder: p.sortOrder })),
        create: async ({ data }: any) => {
          const id = nextId('newph');
          const row: CrudPhoto = {
            id, entryId: data.entryId, status: data.status, imageUrl: null, imageObjectKey: null,
            inboxPath: data.inboxPath, originalName: data.originalName, claimToken: null,
            failureKind: null, failureCode: null, sortOrder: data.sortOrder, attempts: 0, nextAttemptAt: null,
          };
          photos.set(id, row);
          return row;
        },
      },
      plantProgressEntry: {
        update: async ({ where, data }: any) => {
          const e = entries.get(where.id)!;
          Object.assign(e, data);
          return e;
        },
        delete: async ({ where }: any) => {
          entries.delete(where.id);
          for (const [id, p] of photos) if (p.entryId === where.id) photos.delete(id);
          return {};
        },
      },
    };
  }

  const prisma = {
    plant: {
      findFirst: async ({ where }: any) =>
        where.id === 'p1' && (where.ownerId === undefined || where.ownerId === ownerId) ? plant : null,
    },
    plantProgressEntry: {
      findFirst: async ({ where }: any) => {
        const e = entries.get(where.id);
        if (!e || e.plantId !== where.plantId) return null;
        const ph = [...photos.values()].filter((p) => p.entryId === where.id).sort((a, b) => a.sortOrder - b.sortOrder);
        return { ...e, photos: ph.map((p) => ({ ...p })) };
      },
    },
    $transaction: async (fn: any) => fn(makeTx()),
  } as any;

  const images = { upload: vi.fn(), delete: vi.fn(async () => {}) } as any;
  const carePlan = { recomputePlant: vi.fn(async (id: string) => { recomputed.push(id); }) } as any;

  const inbox = {
    stage: vi.fn(async (fs: { buffer: Buffer; originalName: string }[]) => {
      if (opts.capacityThrows) throw new ImageUploadError('photo_storage_busy', 'busy');
      const s = fs.map((f) => ({ inboxPath: `/inbox/${f.originalName}-${nextId('s')}.bin`, originalName: f.originalName, sizeBytes: f.buffer.length }));
      staged.push(...s);
      return s;
    }),
    deleteMany: vi.fn(async () => {}),
    exists: vi.fn(async (path: string | null | undefined) => !!path),
  } as any;
  const worker = { enqueueTick: vi.fn() } as any;

  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const svc = new ProgressService(prisma, owner, images, carePlan, inbox, worker);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });

  return { svc, run, entries, photos, careEvents, recomputed, staged, images, inbox, worker };
}

describe('ProgressService.update (PATCH)', () => {
  it('edits ONLY the present fields; an absent field is left unchanged, a present-empty field clears it', async () => {
    const { svc, run, entries } = setupCrud();
    await run(actor('owner-1'), async () => {
      const out: any = await svc.update('p1', 'entry-1', { observations: '', tags: '[]' } as any, []);
      expect(out.observations).toBeNull();
      expect(out.tags).toEqual([]);
      // health/occurredOn/sizeCm ABSENT → untouched
      expect(out.health).toBe('GOOD');
      expect(out.sizeCm).toBe(12);
      expect(out.occurredOn).toBe('2026-07-02');
    });
    expect(entries.get('entry-1')!.observations).toBeNull();
    expect(entries.get('entry-1')!.health).toBe('GOOD');
  });

  it('changing occurredOn MOVES the paired CareEvent (by progressEntryId) and recomputes', async () => {
    const { svc, run, careEvents, recomputed } = setupCrud();
    await run(actor('owner-1'), async () => {
      const out: any = await svc.update('p1', 'entry-1', { occurredOn: '2026-07-10' } as any, []);
      expect(out.occurredOn).toBe('2026-07-10');
    });
    const ce = careEvents.get('ce1')!;
    expect(ce.occurredOn).toEqual(new Date(Date.UTC(2026, 6, 10))); // native Date, not a toISOString string
    expect(recomputed).toEqual(['p1']);
  });

  it('falls back to the bounded null-FK date UPDATE when no paired event exists (legacy)', async () => {
    const baseOccurredOn = new Date(Date.UTC(2026, 6, 2));
    const { svc, run, careEvents } = setupCrud({
      careEvents: [{ id: 'ce-legacy', plantId: 'p1', task: 'PROGRESS', type: 'DONE', occurredOn: baseOccurredOn, progressEntryId: null }],
    });
    await run(actor('owner-1'), async () => {
      await svc.update('p1', 'entry-1', { occurredOn: '2026-07-10' } as any, []);
    });
    expect(careEvents.get('ce-legacy')!.occurredOn).toEqual(new Date(Date.UTC(2026, 6, 10)));
  });

  it('changing sizeCm recomputes; changing only observations/health/tags/photos does NOT recompute', async () => {
    const a = setupCrud();
    await a.run(actor('owner-1'), async () => { await a.svc.update('p1', 'entry-1', { sizeCm: '20' } as any, []); });
    expect(a.recomputed).toEqual(['p1']);

    const b = setupCrud();
    await b.run(actor('owner-1'), async () => { await b.svc.update('p1', 'entry-1', { observations: 'new text', health: 'EXCELLENT', tags: '["FLOWERING"]' } as any, []); });
    expect(b.recomputed).toEqual([]);
  });

  it('rejects a non-positive or INT-overflowing sizeCm with 400 (parity with create); present-empty clears', async () => {
    const z = setupCrud();
    await z.run(actor('owner-1'), async () => {
      await expect(z.svc.update('p1', 'entry-1', { sizeCm: '0' } as any, [])).rejects.toMatchObject({ response: { code: 'invalid_size' } });
      await expect(z.svc.update('p1', 'entry-1', { sizeCm: '9999999999' } as any, [])).rejects.toMatchObject({ response: { code: 'invalid_size' } });
    });
    // present-empty '' clears to null
    const c = setupCrud();
    await c.run(actor('owner-1'), async () => { await c.svc.update('p1', 'entry-1', { sizeCm: '' } as any, []); });
    expect(c.entries.get('entry-1')?.sizeCm).toBeNull();
  });

  it('adds new photos: stages them, creates PENDING rows with sortOrder = max(existing)+1+i, nudges', async () => {
    const { svc, run, photos, inbox, worker } = setupCrud();
    await run(actor('owner-1'), async () => {
      await svc.update('p1', 'entry-1', {} as any, [file('c'), file('d')]);
    });
    expect(inbox.stage).toHaveBeenCalledTimes(1);
    const newRows = [...photos.values()].filter((p) => p.status === 'PENDING').sort((a, b) => a.sortOrder - b.sortOrder);
    expect(newRows).toHaveLength(2);
    expect(newRows[0].sortOrder).toBe(2);
    expect(newRows[1].sortOrder).toBe(3);
    expect(worker.enqueueTick).toHaveBeenCalledTimes(1);
  });

  it('removes a READY/FAILED/unclaimed-PENDING photo via the guarded delete; cleans R2+inbox AFTER commit', async () => {
    const { svc, run, photos, images, inbox } = setupCrud();
    await run(actor('owner-1'), async () => {
      await svc.update('p1', 'entry-1', { removePhotoIds: JSON.stringify(['ph1']) } as any, []);
    });
    expect(photos.has('ph1')).toBe(false);
    expect(images.delete).toHaveBeenCalledWith('k1');
    // ph1.inboxPath was null → there is nothing to clean, so the inbox is never called. (Before the
    // write-core refactor the service forwarded the raw nulls; the core filters them out.)
    expect(inbox.deleteMany).not.toHaveBeenCalled();
  });

  it('forwards a removed photo REAL inbox path to the inbox cleanup after commit', async () => {
    const staledPhoto: CrudPhoto = { id: 'ph1', entryId: 'entry-1', status: 'FAILED', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: null, failureKind: 'transient', failureCode: null, sortOrder: 0, attempts: 1, nextAttemptAt: null };
    const { svc, run, photos, inbox } = setupCrud({ photos: [staledPhoto] });
    await run(actor('owner-1'), async () => {
      await svc.update('p1', 'entry-1', { removePhotoIds: JSON.stringify(['ph1']) } as any, []);
    });
    expect(photos.has('ph1')).toBe(false);
    expect(inbox.deleteMany).toHaveBeenCalledWith(['/inbox/ph1.bin']);
  });

  it('removing a PROCESSING/claimed photo → 409 photo_processing and mutates NOTHING', async () => {
    const claimedPhoto: CrudPhoto = { id: 'ph1', entryId: 'entry-1', status: 'PROCESSING', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: 'tok', failureKind: null, failureCode: null, sortOrder: 0, attempts: 0, nextAttemptAt: null };
    const { svc, run, photos, entries, careEvents, inbox } = setupCrud({ photos: [claimedPhoto] });
    const beforeEntry = { ...entries.get('entry-1')! };
    const beforeCareEvents = new Map(careEvents);
    await run(actor('owner-1'), async () => {
      await expect(svc.update('p1', 'entry-1', { removePhotoIds: JSON.stringify(['ph1']) } as any, [file('x')]))
        .rejects.toMatchObject({ response: { code: 'photo_processing' } });
    });
    // mutated NOTHING
    expect(photos.get('ph1')).toEqual(claimedPhoto);
    expect(entries.get('entry-1')).toEqual(beforeEntry);
    expect(careEvents).toEqual(beforeCareEvents);
    // any staged files compensated
    expect(inbox.deleteMany).toHaveBeenCalled();
  });

  it('removing a permanent-FAILED photo clears it (guarded delete succeeds)', async () => {
    const failedPhoto: CrudPhoto = { id: 'ph3', entryId: 'entry-1', status: 'FAILED', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ph3.bin', originalName: 'c.jpg', claimToken: null, failureKind: 'permanent', failureCode: 'image_too_large', sortOrder: 0, attempts: 3, nextAttemptAt: null };
    const { svc, run, photos, inbox } = setupCrud({ photos: [failedPhoto] });
    await run(actor('owner-1'), async () => {
      await svc.update('p1', 'entry-1', { removePhotoIds: JSON.stringify(['ph3']) } as any, []);
    });
    expect(photos.has('ph3')).toBe(false);
    expect(inbox.deleteMany).toHaveBeenCalledWith(['/inbox/ph3.bin']);
  });

  it('the ≤8 total invariant returns 400 too_many_photos under the entry-row lock, staged files compensated', async () => {
    const sevenPhotos: CrudPhoto[] = Array.from({ length: 7 }, (_, i) => ({
      id: `ph${i}`, entryId: 'entry-1', status: 'READY', imageUrl: `https://cdn/${i}.webp`, imageObjectKey: `k${i}`,
      inboxPath: null, originalName: `${i}.jpg`, claimToken: null, failureKind: null, failureCode: null, sortOrder: i, attempts: 0, nextAttemptAt: null,
    }));
    const { svc, run, photos, inbox, staged } = setupCrud({ photos: sevenPhotos });
    await run(actor('owner-1'), async () => {
      await expect(svc.update('p1', 'entry-1', {} as any, [file('x'), file('y')]))
        .rejects.toMatchObject({ response: { code: 'too_many_photos' } });
    });
    expect(photos.size).toBe(7); // no rows mutated
    expect(inbox.deleteMany).toHaveBeenCalledWith(staged.map((s) => s.inboxPath));
  });

  it("can't PATCH another owner's entry → 404", async () => {
    const { svc, run } = setupCrud();
    await run(actor('owner-2'), async () => {
      await expect(svc.update('p1', 'entry-1', {} as any, [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

// A single FAILED photo (transient, inbox present) usable across the retryPhoto tests.
function failedTransientPhoto(overrides: Partial<CrudPhoto> = {}): CrudPhoto {
  return {
    id: 'ph1', entryId: 'entry-1', status: 'FAILED', imageUrl: null, imageObjectKey: null,
    inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: null,
    failureKind: 'transient', failureCode: 'upload_failed', sortOrder: 0, attempts: 3, nextAttemptAt: null,
    ...overrides,
  };
}

describe('ProgressService.retryPhoto', () => {
  it('retryable (transient + inbox present) → PENDING, clears attempts/nextAttemptAt/failureKind/failureCode, nudges', async () => {
    const { svc, run, photos, worker } = setupCrud({ photos: [failedTransientPhoto()] });
    await run(actor('owner-1'), async () => {
      await svc.retryPhoto('p1', 'entry-1', 'ph1');
    });
    const p = photos.get('ph1')!;
    expect(p.status).toBe('PENDING');
    expect(p.attempts).toBe(0);
    expect(p.nextAttemptAt).toBeNull();
    expect(p.failureKind).toBeNull();
    expect(p.failureCode).toBeNull();
    expect(p.claimToken).toBeNull();
    expect(worker.enqueueTick).toHaveBeenCalledTimes(1);
  });

  it('permanent failure → 409 not_retryable, photo unchanged', async () => {
    const permanent = failedTransientPhoto({ failureKind: 'permanent', failureCode: 'image_too_large' });
    const { svc, run, photos, worker } = setupCrud({ photos: [permanent] });
    await run(actor('owner-1'), async () => {
      await expect(svc.retryPhoto('p1', 'entry-1', 'ph1')).rejects.toMatchObject({ response: { code: 'not_retryable' } });
    });
    expect(photos.get('ph1')).toEqual(permanent);
    expect(worker.enqueueTick).not.toHaveBeenCalled();
  });

  it('transient but inbox reclaimed by TTL (exists → false) → 409 not_retryable', async () => {
    const reclaimed = failedTransientPhoto({ inboxPath: null });
    const { svc, run, photos, worker } = setupCrud({ photos: [reclaimed] });
    await run(actor('owner-1'), async () => {
      await expect(svc.retryPhoto('p1', 'entry-1', 'ph1')).rejects.toMatchObject({ response: { code: 'not_retryable' } });
    });
    expect(photos.get('ph1')).toEqual(reclaimed); // status stays FAILED
    expect(worker.enqueueTick).not.toHaveBeenCalled();
  });

  it('already-PENDING photo → no-op (returns the entry, no UPDATE, no nudge)', async () => {
    const pending: CrudPhoto = { id: 'ph1', entryId: 'entry-1', status: 'PENDING', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: null, failureKind: null, failureCode: null, sortOrder: 0, attempts: 0, nextAttemptAt: null };
    const { svc, run, photos, worker } = setupCrud({ photos: [pending] });
    await run(actor('owner-1'), async () => {
      const out: any = await svc.retryPhoto('p1', 'entry-1', 'ph1');
      expect(out.id).toBe('entry-1'); // returns the entry
    });
    expect(photos.get('ph1')).toEqual(pending); // unchanged
    expect(worker.enqueueTick).not.toHaveBeenCalled();
  });

  it('READY / PROCESSING / RECOVERING → 409 not_retryable (only an already-PENDING row is the explicit no-op)', async () => {
    for (const status of ['READY', 'PROCESSING', 'RECOVERING']) {
      const row: CrudPhoto = { id: 'ph1', entryId: 'entry-1', status, imageUrl: status === 'READY' ? 'https://cdn/x.webp' : null, imageObjectKey: null, inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: status === 'READY' ? null : 'tok', failureKind: null, failureCode: null, sortOrder: 0, attempts: 0, nextAttemptAt: null };
      const { svc, run, photos, worker } = setupCrud({ photos: [row] });
      await run(actor('owner-1'), async () => {
        await expect(svc.retryPhoto('p1', 'entry-1', 'ph1')).rejects.toMatchObject({ response: { code: 'not_retryable' } });
      });
      expect(photos.get('ph1')).toEqual(row);
      expect(worker.enqueueTick).not.toHaveBeenCalled();
    }
  });

  it("can't retry a photo on another owner's entry → 404", async () => {
    const { svc, run } = setupCrud({ photos: [failedTransientPhoto()] });
    await run(actor('owner-2'), async () => {
      await expect(svc.retryPhoto('p1', 'entry-1', 'ph1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('ProgressService.delete', () => {
  it('deletes the paired CareEvent by progressEntryId FIRST, then the entry (photos cascade); recomputes', async () => {
    const { svc, run, entries, careEvents, photos, recomputed } = setupCrud();
    await run(actor('owner-1'), async () => {
      await svc.delete('p1', 'entry-1');
    });
    expect(entries.has('entry-1')).toBe(false);
    expect(careEvents.has('ce1')).toBe(false);
    expect(photos.has('ph1')).toBe(false); // cascade
    expect(photos.has('ph2')).toBe(false);
    expect(recomputed).toEqual(['p1']);
  });

  it('a sibling same-date entry’s event survives (the pairing is by progressEntryId, not by date)', async () => {
    const { svc, run, entries, careEvents } = setupCrud();
    const sameDate = entries.get('entry-1')!.occurredOn;
    entries.set('entry-2', { id: 'entry-2', plantId: 'p1', occurredOn: sameDate, health: 'GOOD', observations: null, sizeCm: null, tags: [], createdAt: new Date() });
    careEvents.set('ce2', { id: 'ce2', plantId: 'p1', task: 'PROGRESS', type: 'DONE', occurredOn: sameDate, progressEntryId: 'entry-2' });
    await run(actor('owner-1'), async () => {
      await svc.delete('p1', 'entry-1');
    });
    expect(careEvents.has('ce1')).toBe(false); // entry-1's paired event deleted
    expect(careEvents.has('ce2')).toBe(true); // sibling entry-2's PAIRED event survives — the fallback never fires
  });

  it('legacy null-FK event: the by-progressEntryId delete matches 0 → bounded date-fallback DELETE ... IS NULL LIMIT 1', async () => {
    const baseOccurredOn = new Date(Date.UTC(2026, 6, 2));
    const { svc, run, entries, careEvents } = setupCrud({
      careEvents: [{ id: 'ce-legacy', plantId: 'p1', task: 'PROGRESS', type: 'DONE', occurredOn: baseOccurredOn, progressEntryId: null }],
    });
    await run(actor('owner-1'), async () => {
      await svc.delete('p1', 'entry-1');
    });
    expect(entries.has('entry-1')).toBe(false);
    expect(careEvents.has('ce-legacy')).toBe(false); // fallback matched (native Date, not toISOString) & deleted it
  });

  it('a delete while any photo is PROCESSING → 409 photo_processing, nothing mutated', async () => {
    const processing: CrudPhoto = { id: 'ph1', entryId: 'entry-1', status: 'PROCESSING', imageUrl: null, imageObjectKey: null, inboxPath: '/inbox/ph1.bin', originalName: 'a.jpg', claimToken: 'tok', failureKind: null, failureCode: null, sortOrder: 0, attempts: 0, nextAttemptAt: null };
    const { svc, run, entries, photos, careEvents } = setupCrud({ photos: [processing] });
    const beforeEntry = { ...entries.get('entry-1')! };
    const beforeCareEvents = new Map(careEvents);
    await run(actor('owner-1'), async () => {
      await expect(svc.delete('p1', 'entry-1')).rejects.toMatchObject({ response: { code: 'photo_processing' } });
    });
    expect(entries.get('entry-1')).toEqual(beforeEntry);
    expect(photos.get('ph1')).toEqual(processing);
    expect(careEvents).toEqual(beforeCareEvents);
  });

  it('collects R2 objects + inbox paths inside the txn and cleans them AFTER commit (best-effort)', async () => {
    const { svc, run, images, inbox } = setupCrud(); // default photos: ph1/ph2, imageObjectKey k1/k2, inboxPath null
    await run(actor('owner-1'), async () => {
      await svc.delete('p1', 'entry-1');
    });
    expect(images.delete).toHaveBeenCalledWith('k1');
    expect(images.delete).toHaveBeenCalledWith('k2');
    // Both fixtures have a null inboxPath → nothing staged to clean, so the inbox is never called.
    expect(inbox.deleteMany).not.toHaveBeenCalled();
  });

  it("can't delete another owner's entry → 404", async () => {
    const { svc, run } = setupCrud();
    await run(actor('owner-2'), async () => {
      await expect(svc.delete('p1', 'entry-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
