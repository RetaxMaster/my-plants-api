import { describe, it, expect, vi } from 'vitest';
import { updatePlantCore, updateProfileCore } from './plants.write-core.js';

const ownerCtx = { origin: 'OWNER' as const, proposalId: null, actorUserId: 'u1' };

function fakeTx(overrides: Record<string, unknown> = {}) {
  return {
    plant: {
      findFirst: vi.fn(async (_args?: unknown) => ({ id: 'p1', ownerId: 'o1', placeId: 'pl1' })),
      update: vi.fn(async (_args?: unknown) => ({})),
    },
    place: { findFirst: vi.fn(async (_args?: unknown) => ({ id: 'pl2', ownerId: 'o1' })) },
    plantProfile: { upsert: vi.fn(async (_args?: unknown) => ({ plantId: 'p1', potType: 'PLASTIC' })) },
    plantWriteAudit: { create: vi.fn(async (_args?: unknown) => ({})) },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('updatePlantCore', () => {
  it('requests a care-plan recompute only when the place changed', async () => {
    const tx = fakeTx();
    const a = await updatePlantCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      patch: { nickname: 'Randy' },
      audit: ownerCtx,
    });
    expect(a.effects.recomputePlantIds).toEqual([]);
    const b = await updatePlantCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      patch: { placeId: 'pl2' },
      audit: ownerCtx,
    });
    expect(b.effects.recomputePlantIds).toEqual(['p1']);
  });

  it('is a no-op — no write, no recompute, no audit row — when the place is unchanged', async () => {
    const tx = fakeTx();
    const res = await updatePlantCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      patch: { placeId: 'pl1' },
      audit: ownerCtx,
    });
    expect(res.effects.recomputePlantIds).toEqual([]);
    expect(tx.plant.update).not.toHaveBeenCalled();
    expect(tx.plantWriteAudit.create).not.toHaveBeenCalled();
  });

  it('rejects a placeId belonging to another owner', async () => {
    const tx = fakeTx({ place: { findFirst: vi.fn(async (_args?: unknown) => null) } });
    await expect(
      updatePlantCore(tx, { plantId: 'p1', ownerId: 'o1', patch: { placeId: 'other' }, audit: ownerCtx }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('clears the nickname on an explicit null', async () => {
    const tx = fakeTx();
    await updatePlantCore(tx, { plantId: 'p1', ownerId: 'o1', patch: { nickname: null }, audit: ownerCtx });
    expect(tx.plant.update.mock.calls[0][0].data.nickname).toBeNull();
  });

  it('clears the nickname on a whitespace-only string', async () => {
    const tx = fakeTx();
    await updatePlantCore(tx, { plantId: 'p1', ownerId: 'o1', patch: { nickname: '   ' }, audit: ownerCtx });
    expect(tx.plant.update.mock.calls[0][0].data.nickname).toBeNull();
  });

  it('writes one audit row inside the same transaction client', async () => {
    const tx = fakeTx();
    await updatePlantCore(tx, { plantId: 'p1', ownerId: 'o1', patch: { nickname: 'Randy' }, audit: ownerCtx });
    expect(tx.plantWriteAudit.create).toHaveBeenCalledTimes(1);
    expect(tx.plantWriteAudit.create.mock.calls[0][0].data.operationType).toBe('plant.update');
  });

  it('stamps a doctor write with its proposal id', async () => {
    const tx = fakeTx();
    await updatePlantCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      patch: { nickname: 'Randy' },
      audit: { origin: 'DOCTOR', proposalId: 'prop-1', actorUserId: 'u1' },
    });
    const row = tx.plantWriteAudit.create.mock.calls[0][0].data;
    expect(row.origin).toBe('DOCTOR');
    expect(row.proposalId).toBe('prop-1');
  });

  it('404s when the plant does not belong to the owner', async () => {
    const tx = fakeTx({ plant: { findFirst: vi.fn(async (_args?: unknown) => null), update: vi.fn() } });
    await expect(
      updatePlantCore(tx, { plantId: 'p1', ownerId: 'nope', patch: { nickname: 'x' }, audit: ownerCtx }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateProfileCore', () => {
  it('always requests a recompute and audits as profile.update', async () => {
    const tx = fakeTx();
    const res = await updateProfileCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      patch: { potType: 'plastic' },
      audit: ownerCtx,
    });
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
    expect(tx.plantWriteAudit.create.mock.calls[0][0].data.operationType).toBe('profile.update');
  });

  it('404s when the plant does not belong to the owner', async () => {
    const tx = fakeTx({ plant: { findFirst: vi.fn(async (_args?: unknown) => null), update: vi.fn() } });
    await expect(
      updateProfileCore(tx, { plantId: 'p1', ownerId: 'nope', patch: { potType: 'plastic' }, audit: ownerCtx }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
