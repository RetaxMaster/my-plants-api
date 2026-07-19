import { describe, it, expect, vi } from 'vitest';
import { recordFeedbackCore } from './feedback.write-core.js';

const audit = { origin: 'DOCTOR' as const, proposalId: 'prop-1', actorUserId: 'u1' };

const fakeTx = (over: Record<string, unknown> = {}) =>
  ({
    plant: {
      findFirst: vi.fn(async (_a?: unknown) => ({ id: 'p1', ownerId: 'o1' })),
      findUniqueOrThrow: vi.fn(async (_a?: unknown) => ({
        acquiredOn: new Date(Date.UTC(2026, 0, 1)),
        place: { city: { timezone: 'UTC' } },
      })),
    },
    careEvent: {
      create: vi.fn(async (_a?: unknown) => ({ id: 'ce1' })),
      findFirst: vi.fn(async (_a?: unknown) => null),
      count: vi.fn(async (_a?: unknown) => 0),
    },
    taskOverride: {
      deleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
      upsert: vi.fn(async (_a?: unknown) => ({})),
      count: vi.fn(async (_a?: unknown) => 0),
    },
    dueCache: { findUnique: vi.fn(async (_a?: unknown) => null) },
    plantProfile: { findUnique: vi.fn(async (_a?: unknown) => null) },
    plantProgressEntry: { findFirst: vi.fn(async (_a?: unknown) => null) },
    plantTaskAdjustment: {
      findUnique: vi.fn(async (_a?: unknown) => null),
      upsert: vi.fn(async (_a?: unknown) => ({})),
    },
    plantWriteAudit: { create: vi.fn(async (_a?: unknown) => ({})) },
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('recordFeedbackCore', () => {
  it('records a DONE care event and clears the task override', async () => {
    const tx = fakeTx();
    const res = await recordFeedbackCore(tx, {
      plantId: 'p1',
      ownerId: 'o1',
      task: 'WATER',
      type: 'DONE',
      occurredOn: new Date(Date.UTC(2026, 6, 18)),
      audit,
    });
    expect(tx.careEvent.create).toHaveBeenCalled();
    expect(tx.taskOverride.deleteMany).toHaveBeenCalled();
    expect(res.effects.recomputePlantIds).toEqual(['p1']);
  });

  it('rejects the reserved PROGRESS task before reading or writing anything', async () => {
    const tx = fakeTx();
    await expect(
      recordFeedbackCore(tx, {
        plantId: 'p1', ownerId: 'o1', task: 'PROGRESS', type: 'DONE', occurredOn: new Date(), audit,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.plant.findFirst).not.toHaveBeenCalled();
    expect(tx.careEvent.create).not.toHaveBeenCalled();
  });

  it('audits as care.done with the proposal id when the origin is DOCTOR', async () => {
    const tx = fakeTx();
    await recordFeedbackCore(tx, {
      plantId: 'p1', ownerId: 'o1', task: 'WATER', type: 'DONE', occurredOn: new Date(), audit,
    });
    const row = tx.plantWriteAudit.create.mock.calls[0][0].data;
    expect(row.operationType).toBe('care.done');
    expect(row.proposalId).toBe('prop-1');
    expect(row.origin).toBe('DOCTOR');
  });

  it('404s for a plant the owner does not own', async () => {
    const tx = fakeTx({ plant: { findFirst: vi.fn(async (_a?: unknown) => null) } });
    await expect(
      recordFeedbackCore(tx, {
        plantId: 'p1', ownerId: 'nope', task: 'WATER', type: 'DONE', occurredOn: new Date(), audit,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('captures WATER adherence BEFORE deleting the override, so a postponed cycle is not double-counted', async () => {
    const calls: string[] = [];
    const tx = fakeTx({
      // computeAdherence returns null without a due-cache row (there is no schedule to measure
      // against), so an adherence assertion needs one.
      dueCache: { findUnique: vi.fn(async () => ({ nextDueOn: new Date(Date.UTC(2026, 6, 15)) })) },
      taskOverride: {
        count: vi.fn(async () => { calls.push('count'); return 1; }),
        deleteMany: vi.fn(async () => { calls.push('deleteMany'); return { count: 1 }; }),
        upsert: vi.fn(async () => ({})),
      },
    });
    await recordFeedbackCore(tx, {
      plantId: 'p1', ownerId: 'o1', task: 'WATER', type: 'DONE', occurredOn: new Date(Date.UTC(2026, 6, 18)), audit,
    });
    expect(calls).toEqual(['count', 'deleteMany']);
    // The override was active → this cycle carries an adherence payload marked ineligible.
    const payload = tx.careEvent.create.mock.calls[0][0].data.payload;
    expect(payload.adherence).toBeDefined();
  });

  it('writes a POSTPONED override and audits as care.postponed', async () => {
    const tx = fakeTx();
    await recordFeedbackCore(tx, {
      plantId: 'p1', ownerId: 'o1', task: 'FERTILIZE', type: 'POSTPONED',
      occurredOn: new Date(Date.UTC(2026, 6, 18)), postponeToOn: new Date(Date.UTC(2026, 6, 25)), audit,
    });
    expect(tx.taskOverride.upsert).toHaveBeenCalled();
    expect(tx.plantWriteAudit.create.mock.calls[0][0].data.operationType).toBe('care.postponed');
  });

  it('does NOT nudge the raw multiplier on a WATER postpone (it learns from the reason window)', async () => {
    const tx = fakeTx();
    await recordFeedbackCore(tx, {
      plantId: 'p1', ownerId: 'o1', task: 'WATER', type: 'POSTPONED',
      occurredOn: new Date(), postponeToOn: new Date(Date.UTC(2026, 6, 25)), audit,
    });
    expect(tx.plantTaskAdjustment.upsert).not.toHaveBeenCalled();
  });

  it('routes REPOT down the inspection flow, never the generic un-gated adapt()', async () => {
    const tx = fakeTx();
    await recordFeedbackCore(tx, {
      plantId: 'p1', ownerId: 'o1', task: 'REPOT', type: 'DONE', occurredOn: new Date(Date.UTC(2026, 6, 18)), audit,
    });
    const payload = tx.careEvent.create.mock.calls[0][0].data.payload;
    expect(payload.routedTo).toBe('done'); // the REPOT DONE marker, not a generic care event
    expect(tx.plantTaskAdjustment.upsert).not.toHaveBeenCalled();
  });

  it('rejects a REPOT feedback that is neither DONE nor POSTPONED', async () => {
    const tx = fakeTx();
    await expect(
      recordFeedbackCore(tx, {
        plantId: 'p1', ownerId: 'o1', task: 'REPOT', type: 'SYMPTOM', occurredOn: new Date(), audit,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
