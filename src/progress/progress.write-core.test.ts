import { describe, it, expect, vi } from 'vitest';
import { createProgressCore, updateProgressCore, deleteProgressCore } from './progress.write-core.js';

const audit = { origin: 'DOCTOR' as const, proposalId: 'prop-1', actorUserId: 'u1' };

function fakeTx(over: Record<string, unknown> = {}) {
  return {
    plant: { findFirst: vi.fn(async (_a?: unknown) => ({ id: 'p1', ownerId: 'o1' })) },
    plantProgressEntry: {
      create: vi.fn(async (_a?: unknown) => ({ id: 'e1' })),
      update: vi.fn(async (_a?: unknown) => ({ id: 'e1' })),
      delete: vi.fn(async (_a?: unknown) => ({ id: 'e1' })),
    },
    plantProgressPhoto: {
      findMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
      create: vi.fn(async (_a?: unknown) => ({})),
    },
    careEvent: { create: vi.fn(async (_a?: unknown) => ({})) },
    plantWriteAudit: { create: vi.fn(async (_a?: unknown) => ({})) },
    // The delete path locks the entry AND its photo rows with raw FOR UPDATE reads.
    $queryRaw: vi.fn(async (_a?: unknown) => [{ id: 'e1', occurred_on: new Date(Date.UTC(2026, 6, 1)) }]),
    $executeRaw: vi.fn(async (_a?: unknown) => 1),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('createProgressCore', () => {
  it('creates the entry and its paired PROGRESS care event, and asks for a recompute', async () => {
    const tx = fakeTx();
    const res = await createProgressCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      audit,
      data: { health: 'GOOD', occurredOn: new Date(Date.UTC(2026, 6, 18)), observations: null, sizeCm: null, tags: [] },
      photos: [],
    });
    expect(tx.plantProgressEntry.create).toHaveBeenCalled();
    expect(tx.careEvent.create).toHaveBeenCalled();
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
    expect(res.result.entryId).toBe('e1');
  });

  it('leaves tags UNDEFINED when empty rather than writing an empty array', async () => {
    const tx = fakeTx();
    await createProgressCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      audit,
      data: { health: 'GOOD', occurredOn: new Date(), observations: null, sizeCm: null, tags: [] },
      photos: [],
    });
    expect(tx.plantProgressEntry.create.mock.calls[0][0].data.tags).toBeUndefined();
  });

  it('stages photos as PENDING with index sortOrder and asks for a worker tick', async () => {
    const tx = fakeTx();
    const res = await createProgressCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      audit,
      data: { health: 'GOOD', occurredOn: new Date(), observations: null, sizeCm: null, tags: [] },
      photos: [
        { inboxPath: '/i/a', originalName: 'a' },
        { inboxPath: '/i/b', originalName: 'b' },
      ],
    });
    const created = tx.plantProgressEntry.create.mock.calls[0][0].data.photos.create;
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ status: 'PENDING', sortOrder: 0 });
    expect(created[1].sortOrder).toBe(1);
    expect(res.effects.enqueuePhotoTick).toBe(true);
  });

  it('404s for a plant the owner does not own', async () => {
    const tx = fakeTx({ plant: { findFirst: vi.fn(async (_a?: unknown) => null) } });
    await expect(
      createProgressCore(tx, {
        plantId: 'p1',
        ownerId: 'nope',
        audit,
        data: { health: 'GOOD', occurredOn: new Date(), observations: null, sizeCm: null, tags: [] },
        photos: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateProgressCore', () => {
  it('rejects an entryId that belongs to another plant', async () => {
    const tx = fakeTx({ $queryRaw: vi.fn(async (_a?: unknown) => []) });
    await expect(
      updateProgressCore(tx, {
        plantId: 'p1', ownerId: 'o1', entryId: 'other', audit,
        data: { observations: 'hi' }, photos: [], removePhotoIds: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('clears observations on an explicit null and keeps absent fields unchanged', async () => {
    const tx = fakeTx();
    await updateProgressCore(tx, {
      plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
      data: { observations: null }, photos: [], removePhotoIds: [],
    });
    const data = tx.plantProgressEntry.update.mock.calls[0][0].data;
    expect(data.observations).toBeNull();
    expect('sizeCm' in data).toBe(false);
  });

  it('recomputes only when occurredOn or sizeCm are present', async () => {
    const txA = fakeTx();
    const a = await updateProgressCore(txA, {
      plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
      data: { observations: 'hi' }, photos: [], removePhotoIds: [],
    });
    expect(a.effects.recomputePlantIds).toEqual([]);

    const txB = fakeTx();
    const b = await updateProgressCore(txB, {
      plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
      data: { sizeCm: 20 }, photos: [], removePhotoIds: [],
    });
    expect(b.effects.recomputePlantIds).toEqual(['p1']);
  });

  it('409s when a removal targets a claimed photo, and mutates nothing', async () => {
    const tx = fakeTx({
      plantProgressPhoto: {
        findMany: vi.fn(async (_a?: unknown) => [
          { id: 'ph1', status: 'PROCESSING', claimToken: 'tok', imageObjectKey: null, inboxPath: '/i/1', sortOrder: 0 },
        ]),
        create: vi.fn(async (_a?: unknown) => ({})),
      },
    });
    await expect(
      updateProgressCore(tx, {
        plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
        data: {}, photos: [], removePhotoIds: ['ph1'],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.plantProgressEntry.update).not.toHaveBeenCalled();
  });

  it('400s when a removal targets a photo of another entry', async () => {
    const tx = fakeTx();
    await expect(
      updateProgressCore(tx, {
        plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
        data: {}, photos: [], removePhotoIds: ['ghost'],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('400s when the ≤8 photo invariant would be exceeded', async () => {
    const existing = Array.from({ length: 7 }, (_, i) => ({
      id: `ph${i}`, status: 'READY', claimToken: null, imageObjectKey: null, inboxPath: null, sortOrder: i,
    }));
    const tx = fakeTx({
      plantProgressPhoto: {
        findMany: vi.fn(async (_a?: unknown) => existing),
        create: vi.fn(async (_a?: unknown) => ({})),
      },
    });
    await expect(
      updateProgressCore(tx, {
        plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
        data: {},
        photos: [{ inboxPath: '/i/a', originalName: 'a' }, { inboxPath: '/i/b', originalName: 'b' }],
        removePhotoIds: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('continues sortOrder from the current max instead of renumbering', async () => {
    const tx = fakeTx({
      plantProgressPhoto: {
        findMany: vi.fn(async (_a?: unknown) => [
          { id: 'ph5', status: 'READY', claimToken: null, imageObjectKey: null, inboxPath: null, sortOrder: 5 },
        ]),
        create: vi.fn(async (_a?: unknown) => ({})),
      },
    });
    await updateProgressCore(tx, {
      plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
      data: {}, photos: [{ inboxPath: '/i/a', originalName: 'a' }], removePhotoIds: [],
    });
    expect(tx.plantProgressPhoto.create.mock.calls[0][0].data.sortOrder).toBe(6);
  });

  it('writes no audit row when the PATCH changed nothing at all', async () => {
    const tx = fakeTx();
    await updateProgressCore(tx, {
      plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit,
      data: {}, photos: [], removePhotoIds: [],
    });
    expect(tx.plantWriteAudit.create).not.toHaveBeenCalled();
  });
});

describe('deleteProgressCore', () => {
  it('returns the object keys and inbox paths to clean up after commit', async () => {
    const tx = fakeTx({
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'e1', occurred_on: new Date(Date.UTC(2026, 6, 1)) }])
        .mockResolvedValueOnce([
          { id: 'ph1', status: 'READY', claim_token: null, image_object_key: 'k1', inbox_path: 'i1' },
        ]),
    });
    const res = await deleteProgressCore(tx, { plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit });
    expect(res.effects.deleteObjectKeys).toEqual(['k1']);
    expect(res.effects.deleteInboxPaths).toEqual(['i1']);
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
    expect(tx.plantProgressEntry.delete).toHaveBeenCalled();
  });

  it('409s when a photo is still being processed', async () => {
    const tx = fakeTx({
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'e1', occurred_on: new Date(Date.UTC(2026, 6, 1)) }])
        .mockResolvedValueOnce([
          { id: 'ph1', status: 'PROCESSING', claim_token: 'tok', image_object_key: null, inbox_path: 'i1' },
        ]),
    });
    await expect(
      deleteProgressCore(tx, { plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.plantProgressEntry.delete).not.toHaveBeenCalled();
  });

  it('locks the photo rows with a FOR UPDATE read, not a plain findMany', async () => {
    const tx = fakeTx({
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'e1', occurred_on: new Date(Date.UTC(2026, 6, 1)) }])
        .mockResolvedValueOnce([]),
    });
    await deleteProgressCore(tx, { plantId: 'p1', ownerId: 'o1', entryId: 'e1', audit });
    // A plain findMany would NOT block the photo worker's PENDING→PROCESSING claim (async spec §4.2).
    expect(tx.plantProgressPhoto.findMany).not.toHaveBeenCalled();
    const photoLockSql = tx.$queryRaw.mock.calls[1][0].strings.join(' ');
    expect(photoLockSql).toContain('plant_progress_photos');
    expect(photoLockSql).toContain('FOR UPDATE');
  });
});
