import { describe, it, expect, vi } from 'vitest';
import { setFrequencyCore, clearFrequencyCore, FREQUENCY_TASKS } from './frequency.write-core.js';

const audit = { origin: 'DOCTOR' as const, proposalId: 'prop-1', actorUserId: 'u1' };

const fakeTx = (over: Record<string, unknown> = {}) =>
  ({
    plant: { findFirst: vi.fn(async (_a?: unknown) => ({ id: 'p1', ownerId: 'o1' })) },
    plantTaskFrequency: {
      upsert: vi.fn(async (_a?: unknown) => ({})),
      deleteMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
    },
    plantWriteAudit: { create: vi.fn(async (_a?: unknown) => ({})) },
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('frequency write cores', () => {
  it('upserts the override and requests a recompute', async () => {
    const tx = fakeTx();
    const res = await setFrequencyCore(tx, { plantId: 'p1', ownerId: 'o1', task: 'WATER', intervalDays: 5, audit });
    expect(tx.plantTaskFrequency.upsert).toHaveBeenCalled();
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
  });

  it('rejects the reserved PROGRESS task', async () => {
    await expect(
      setFrequencyCore(fakeTx(), { plantId: 'p1', ownerId: 'o1', task: 'PROGRESS', intervalDays: 5, audit }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an unknown task string', async () => {
    await expect(
      setFrequencyCore(fakeTx(), { plantId: 'p1', ownerId: 'o1', task: 'NONSENSE', intervalDays: 5, audit }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('validates the task BEFORE touching the plant, so a bad task never reads or writes', async () => {
    const tx = fakeTx();
    await expect(
      setFrequencyCore(tx, { plantId: 'p1', ownerId: 'o1', task: 'PROGRESS', intervalDays: 5, audit }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.plant.findFirst).not.toHaveBeenCalled();
    expect(tx.plantTaskFrequency.upsert).not.toHaveBeenCalled();
  });

  it('clears an override and audits it', async () => {
    const tx = fakeTx();
    await clearFrequencyCore(tx, { plantId: 'p1', ownerId: 'o1', task: 'WATER', audit });
    expect(tx.plantTaskFrequency.deleteMany).toHaveBeenCalled();
    expect(tx.plantWriteAudit.create.mock.calls[0][0].data.operationType).toBe('frequency.clear');
  });

  it('writes no audit row when clearing an override that did not exist', async () => {
    const tx = fakeTx({
      plantTaskFrequency: {
        upsert: vi.fn(async (_a?: unknown) => ({})),
        deleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
      },
    });
    const res = await clearFrequencyCore(tx, { plantId: 'p1', ownerId: 'o1', task: 'WATER', audit });
    expect(tx.plantWriteAudit.create).not.toHaveBeenCalled();
    // The recompute still runs: a fresh plan is never wrong, and this mirrors pre-refactor behavior.
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
  });

  it('stamps the audit row with the doctor origin and proposal id', async () => {
    const tx = fakeTx();
    await setFrequencyCore(tx, { plantId: 'p1', ownerId: 'o1', task: 'WATER', intervalDays: 5, audit });
    const row = tx.plantWriteAudit.create.mock.calls[0][0].data;
    expect(row.origin).toBe('DOCTOR');
    expect(row.proposalId).toBe('prop-1');
    expect(row.operationType).toBe('frequency.set');
  });

  it('404s for a plant the owner does not own', async () => {
    const tx = fakeTx({ plant: { findFirst: vi.fn(async (_a?: unknown) => null) } });
    await expect(
      clearFrequencyCore(tx, { plantId: 'p1', ownerId: 'x', task: 'WATER', audit }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('exposes the six frequency-bearing tasks, PROGRESS excluded', async () => {
    expect([...FREQUENCY_TASKS].sort()).toEqual(
      ['CLEAN_LEAVES', 'FERTILIZE', 'MIST', 'REPOT', 'ROTATE', 'WATER'],
    );
  });
});
