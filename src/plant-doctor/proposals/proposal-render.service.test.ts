import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposalRenderService, FIELD_LABELS } from './proposal-render.service.js';
import { operationSchema } from './proposal-operations.schema.js';

type Query = { where: Record<string, unknown> };

function fakes() {
  const snapshotSvc = {
    capture: vi.fn(async (_p: string, _o: string, _ops: unknown[]) => [{ intervalDays: 9 }] as unknown[]),
  };
  const prisma = {
    place: { findFirst: vi.fn(async (_q: Query) => ({ id: 'pl2', name: 'Living room' })) },
    plantProgressEntry: {
      findFirst: vi.fn(async (_q: Query) => ({ id: 'e1', occurredOn: new Date(Date.UTC(2026, 6, 1)) })),
    },
  };
  return { snapshotSvc, prisma };
}

type Fakes = ReturnType<typeof fakes>;
const build = (f: Fakes) =>
  new ProposalRenderService(
    f.prisma as unknown as ConstructorParameters<typeof ProposalRenderService>[0],
    f.snapshotSvc as unknown as ConstructorParameters<typeof ProposalRenderService>[1],
  );

const baseProposal = {
  id: 'prop-1',
  summary: 'update the nickname',
  status: 'PENDING',
  autoApproved: false,
  failureCode: null,
  failureReason: null,
  createdAt: new Date(),
  operations: JSON.stringify([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]),
  snapshot: JSON.stringify([{ intervalDays: 7 }]),
  plantId: 'p1',
  ownerId: 'o1',
};

const withOps = (operations: unknown[], snapshot: unknown[]) => ({
  ...baseProposal,
  operations: JSON.stringify(operations),
  snapshot: JSON.stringify(snapshot),
});

describe('ProposalRenderService', () => {
  let f: Fakes;
  let svc: ProposalRenderService;

  beforeEach(() => {
    f = fakes();
    svc = build(f);
  });

  it('renders the canonical operation list as SERVER-RENDERED field changes, summary as a caption', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]); // live == snapshot: not stale
    const view = await svc.render(baseProposal as never);
    expect(view.summary).toBe('update the nickname');
    expect(view.operations[0]).toMatchObject({ type: 'frequency.set', targetLabel: 'WATER', destructive: false });
    // Every value on the wire is a display STRING the server owns — never a raw payload object.
    expect(view.operations[0]!.changes).toEqual([{ field: 'Every (days)', before: '7', after: '5' }]);
  });

  it('when the record drifted, `before` is the LIVE value and `stale` carries what the agent saw', async () => {
    const view = await svc.render(baseProposal as never); // live capture returns intervalDays 9
    // Spec 5.5.3: all three values are present — snapshot (stale.atProposeTime), live (before), proposed (after).
    expect(view.operations[0]!.changes[0]).toEqual({
      field: 'Every (days)',
      before: '9',
      after: '5',
      stale: { atProposeTime: '7' },
    });
  });

  it('omits `stale` entirely when live matches the snapshot', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]);
    const view = await svc.render(baseProposal as never);
    expect(view.operations[0]!.changes[0]!.stale).toBeUndefined();
  });

  it('excludes identity keys from `changes` — they are the target, not a change', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ observations: 'old' }]);
    const p = withOps([{ type: 'progress.update', entryId: 'e1', observations: 'new' }], [{ observations: 'old' }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes.map((c) => c.field)).toEqual(['Observations']);
    expect(view.operations[0]!.targetLabel).toBe('2026-07-01');
  });

  it('renders a clear as `after: null`', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ observations: 'old' }]);
    const p = withOps([{ type: 'progress.update', entryId: 'e1', observations: null }], [{ observations: 'old' }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes[0]).toEqual({ field: 'Observations', before: 'old', after: null });
  });

  it('marks a progress.delete as destructive AND renders its vanishing fields', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ health: 'GOOD', observations: 'looking better' }]);
    const p = withOps(
      [{ type: 'progress.delete', entryId: 'e1' }],
      [{ health: 'GOOD', observations: 'looking better' }],
    );
    const view = await svc.render(p as never);
    expect(view.operations[0]!.destructive).toBe(true);
    expect(view.operations[0]!.targetLabel).toBe('2026-07-01');
    // A destructive operation proposes NO values. If `changes` were built from the proposed keys alone
    // this would be [], and the banner would ask the owner to approve a blank.
    expect(view.operations[0]!.changes).toEqual([
      { field: 'Health', before: 'GOOD', after: null },
      { field: 'Observations', before: 'looking better', after: null },
    ]);
  });

  it('renders frequency.clear as the current cadence going away, not as an empty change list', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]);
    const p = withOps([{ type: 'frequency.clear', task: 'WATER' }], [{ intervalDays: 7 }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.targetLabel).toBe('WATER');
    expect(view.operations[0]!.changes).toEqual([{ field: 'Every (days)', before: '7', after: null }]);
  });

  it('resolves placeId to the place NAME, owner-scoped — never a raw id', async () => {
    f.prisma.place.findFirst
      .mockResolvedValueOnce({ id: 'pl1', name: 'Bedroom' }) // before
      .mockResolvedValueOnce({ id: 'pl2', name: 'Living room' }); // after
    f.snapshotSvc.capture.mockResolvedValueOnce([{ placeId: 'pl1' }]);
    const p = withOps([{ type: 'plant.update', placeId: 'pl2' }], [{ placeId: 'pl1' }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes).toEqual([{ field: 'Place', before: 'Bedroom', after: 'Living room' }]);
    // Owner-scoped: a foreign place must never resolve to a name.
    for (const call of f.prisma.place.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ ownerId: 'o1' });
    }
  });

  it('falls back to the raw id when a place does not resolve, rather than rendering "null"', async () => {
    // A place the owner cannot see must not silently become an empty or misleading label — the owner
    // would be approving a move to somewhere unnamed.
    f.prisma.place.findFirst.mockResolvedValue(null as never);
    f.snapshotSvc.capture.mockResolvedValueOnce([{ placeId: 'pl1' }]);
    const p = withOps([{ type: 'plant.update', placeId: 'pl2' }], [{ placeId: 'pl1' }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes[0]).toMatchObject({ before: 'pl1', after: 'pl2' });
  });

  it('renders booleans and empty tag lists as owner-readable values, not raw JSON', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ hasDrainage: false, tags: ['NEW_LEAF'] }]);
    const p = withOps(
      [{ type: 'profile.update', hasDrainage: true }],
      [{ hasDrainage: false }],
    );
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes).toEqual([{ field: 'Drainage', before: 'No', after: 'Yes' }]);
  });

  it('renders a cleared tag list as `after: null` rather than an empty string', async () => {
    f.snapshotSvc.capture.mockResolvedValueOnce([{ tags: ['NEW_LEAF'] }]);
    const p = withOps([{ type: 'progress.update', entryId: 'e1', tags: [] }], [{ tags: ['NEW_LEAF'] }]);
    const view = await svc.render(p as never);
    expect(view.operations[0]!.changes[0]).toEqual({ field: 'Tags', before: 'NEW_LEAF', after: null });
  });

  it('never emits an empty change list for an operation that touches at least one field', async () => {
    // Guards the union-of-keys rule generally: an empty `changes` on a non-empty operation is a bug.
    f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]);
    const view = await svc.render(baseProposal as never);
    expect(view.operations.every((o) => o.changes.length > 0)).toBe(true);
  });

  it('has a label for every field ANY operation in the union can write (no raw key leaks)', async () => {
    // DERIVED from the schema, not a hand-written list: the point is that adding a field to the
    // operations union without labelling it goes red HERE rather than shipping a raw key like
    // `potSizeCm` into the owner's approval banner. A hand-maintained list in this test would simply
    // be a second thing to forget to update.
    const union = operationSchema.innerType();
    const identity = new Set(['type', 'entryId', 'task']);
    const fields = new Set<string>();
    for (const member of union.options) {
      for (const key of Object.keys(member.shape)) if (!identity.has(key)) fields.add(key);
    }
    expect(fields.size).toBeGreaterThan(10); // the walk actually found the shapes
    for (const field of fields) {
      expect(FIELD_LABELS[field], `missing owner-facing label for operation field "${field}"`).toBeTruthy();
    }
  });
});
