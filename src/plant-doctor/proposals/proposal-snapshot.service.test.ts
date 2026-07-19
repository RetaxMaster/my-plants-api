import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposalSnapshotService } from './proposal-snapshot.service.js';

/**
 * Prisma query arguments, typed only as far as these tests assert on them. Declaring the parameter
 * is what makes `.mock.calls[0][0].where` compile: a `vi.fn(async () => …)` has a zero-length
 * argument tuple, so indexing it is a type error under `tsc --noEmit` (which covers test files).
 */
type Query = { where: Record<string, unknown> };

function fakePrisma(over: Record<string, unknown> = {}) {
  return {
    plant: { findFirst: vi.fn(async (_q: Query) => ({ id: 'p1', nickname: 'Randy', placeId: 'pl1' })) },
    plantProfile: { findUnique: vi.fn(async (_q: Query) => ({ plantId: 'p1', potType: 'plastic', potSizeCm: 14 })) },
    plantProgressEntry: {
      findFirst: vi.fn(async (_q: Query) => ({
        id: 'e1',
        health: 'GOOD',
        occurredOn: new Date(Date.UTC(2026, 6, 1)),
        observations: 'old',
        sizeCm: 10,
        tags: ['NEW_LEAF'],
      })),
    },
    plantTaskFrequency: { findFirst: vi.fn(async (_q: Query) => ({ task: 'WATER', intervalDays: 7 })) },
    ...over,
  };
}

/**
 * The fake is kept STRUCTURALLY typed (never `as never`) so `.mock.calls[0][0].where` still
 * type-checks — `tsc --noEmit` covers test files, and a `never`-typed fake silently disables every
 * assertion about HOW the service queried, which is exactly what the owner-scoping test asserts.
 */
type FakePrisma = ReturnType<typeof fakePrisma>;
const asService = (p: FakePrisma) => p as unknown as ConstructorParameters<typeof ProposalSnapshotService>[0];

describe('ProposalSnapshotService', () => {
  let prisma: FakePrisma;
  let svc: ProposalSnapshotService;

  beforeEach(() => {
    prisma = fakePrisma();
    svc = new ProposalSnapshotService(asService(prisma));
  });

  it('captures only the fields each operation touches', async () => {
    const snap = await svc.capture('p1', 'o1', [{ type: 'profile.update', potType: 'terracotta' } as never]);
    expect(snap[0]).toEqual({ potType: 'plastic' });
    expect(snap[0]).not.toHaveProperty('potSizeCm');
  });

  it('captures a progress entry before-state as YYYY-MM-DD, not an ISO instant', async () => {
    const snap = await svc.capture('p1', 'o1', [
      { type: 'progress.update', entryId: 'e1', observations: 'new' } as never,
    ]);
    expect(snap[0]).toEqual({ observations: 'old' });
    const full = await svc.capture('p1', 'o1', [
      { type: 'progress.update', entryId: 'e1', occurredOn: '2026-07-18' } as never,
    ]);
    expect(full[0]).toEqual({ occurredOn: '2026-07-01' });
  });

  it('captures null for a create (nothing existed before)', async () => {
    const snap = await svc.capture('p1', 'o1', [
      { type: 'progress.create', health: 'GOOD', occurredOn: '2026-07-18' } as never,
    ]);
    expect(snap[0]).toBeNull();
  });

  it('captures the current interval for a frequency change', async () => {
    const snap = await svc.capture('p1', 'o1', [{ type: 'frequency.set', task: 'WATER', intervalDays: 5 } as never]);
    expect(snap[0]).toEqual({ intervalDays: 7 });
  });

  it('captures null intervalDays when no cadence override exists yet', async () => {
    prisma = fakePrisma({ plantTaskFrequency: { findFirst: vi.fn(async (_q: Query) => null) } });
    svc = new ProposalSnapshotService(asService(prisma));
    const snap = await svc.capture('p1', 'o1', [{ type: 'frequency.set', task: 'WATER', intervalDays: 5 } as never]);
    expect(snap[0]).toEqual({ intervalDays: null });
  });

  it('captures the whole entry for a delete — the values that are about to vanish', async () => {
    const snap = await svc.capture('p1', 'o1', [{ type: 'progress.delete', entryId: 'e1' } as never]);
    expect(snap[0]).toEqual({
      health: 'GOOD',
      occurredOn: '2026-07-01',
      observations: 'old',
      sizeCm: 10,
      tags: ['NEW_LEAF'],
    });
  });

  it('is positionally aligned with operations, one entry each', async () => {
    const snap = await svc.capture('p1', 'o1', [
      { type: 'frequency.set', task: 'WATER', intervalDays: 5 } as never,
      { type: 'progress.create', health: 'GOOD' } as never,
      { type: 'plant.update', nickname: 'Bob' } as never,
    ]);
    expect(snap).toHaveLength(3);
    expect(snap[0]).toEqual({ intervalDays: 7 });
    expect(snap[1]).toBeNull();
    expect(snap[2]).toEqual({ nickname: 'Randy' });
  });

  it('scopes every read to the proposal plant AND owner', async () => {
    // The snapshot feeds the consent banner. An unscoped read would let a foreign record's value be
    // captured and later RENDERED to this owner, which is a leak through the approval surface.
    await svc.capture('p1', 'o1', [
      { type: 'plant.update', nickname: 'Bob' } as never,
      { type: 'progress.update', entryId: 'e1', observations: 'new' } as never,
      { type: 'frequency.set', task: 'WATER', intervalDays: 5 } as never,
    ]);
    expect(prisma.plant.findFirst.mock.calls[0]![0].where).toMatchObject({ id: 'p1', ownerId: 'o1' });
    expect(prisma.plantProgressEntry.findFirst.mock.calls[0]![0].where).toMatchObject({ id: 'e1', plantId: 'p1' });
    expect(prisma.plantTaskFrequency.findFirst.mock.calls[0]![0].where).toMatchObject({ plantId: 'p1' });
  });

  it('captures null when the referenced progress entry does not exist', async () => {
    prisma = fakePrisma({ plantProgressEntry: { findFirst: vi.fn(async (_q: Query) => null) } });
    svc = new ProposalSnapshotService(asService(prisma));
    const snap = await svc.capture('p1', 'o1', [{ type: 'progress.delete', entryId: 'gone' } as never]);
    expect(snap[0]).toBeNull();
  });
});
