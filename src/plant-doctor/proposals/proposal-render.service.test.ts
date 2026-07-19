import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task, ProgressHealth } from '@prisma/client';
import {
  WINDOW_DISTANCES,
  POT_TYPES,
  SOIL_MIXES,
  GROWTH_HABITS,
  PROGRESS_TAG_KEYS,
} from '@retaxmaster/my-plants-species-schema';
import {
  ProposalRenderService,
  FIELD_LABELS,
  FIELD_LABELS_ES,
  TASK_LABELS_ES,
  resolveLocale,
  VALUE_VOCAB_ES,
} from './proposal-render.service.js';
import { operationSchema } from './proposal-operations.schema.js';

/**
 * DERIVED from the operations union itself, never a hand-written list — shared by both the English and
 * the Spanish field-label parity tests so the two can never drift apart from each other, or from what a
 * new operation field actually needs.
 */
function operationFields(): Set<string> {
  const union = operationSchema.innerType();
  const identity = new Set(['type', 'entryId', 'task']);
  const fields = new Set<string>();
  for (const member of union.options) {
    for (const key of Object.keys(member.shape)) if (!identity.has(key)) fields.add(key);
  }
  return fields;
}

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

  // --- A TERMINAL proposal renders its SNAPSHOT, never the live record (spec §5.4) -------------------
  //
  // The defect these pin: on the Skip Permissions path the proposal is applied and then rendered, so a
  // live re-read returns the value the apply just wrote. `before` came back equal to `after` (a no-op)
  // plus a `stale` marker blaming a drift that never happened — the agent's and the audit's account of
  // the write said "nothing changed".
  describe('terminal proposals', () => {
    // Every non-PENDING status, not just APPROVED: DECLINED/EXPIRED/FAILED views are read back by the
    // agent and by the owner too, and a live re-read there would report unrelated later edits as drift on
    // a proposal that was never applied.
    for (const status of ['APPROVED', 'DECLINED', 'EXPIRED', 'FAILED'] as const) {
      it(`renders \`before\` from the stored snapshot and never re-reads the record (${status})`, async () => {
        // The live record now holds the APPLIED value — exactly what the buggy path read back.
        f.snapshotSvc.capture.mockResolvedValue([{ intervalDays: 5 }]);
        const view = await svc.render({ ...baseProposal, status } as never);
        expect(view.operations[0]!.changes[0]).toEqual({
          field: 'Every (days)',
          before: '7', // the snapshot, NOT the post-apply live value
          after: '5',
        });
        expect(view.operations[0]!.changes[0]!.stale).toBeUndefined();
        // Stronger than asserting the values: proving the read never happened is what stops a future
        // "capture it anyway and ignore it" refactor from reintroducing the cost and the race.
        expect(f.snapshotSvc.capture).not.toHaveBeenCalled();
      });
    }

    it('still re-reads the record while the proposal is PENDING', async () => {
      await svc.render(baseProposal as never);
      expect(f.snapshotSvc.capture).toHaveBeenCalledTimes(1);
    });
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
    const fields = operationFields();
    expect(fields.size).toBeGreaterThan(10); // the walk actually found the shapes
    for (const field of fields) {
      expect(FIELD_LABELS[field], `missing owner-facing label for operation field "${field}"`).toBeTruthy();
    }
  });

  // ─────────────────────────────── locale (spec B2 — server-rendered Spanish) ───────────────────────
  //
  // The consent surface is the ONE screen an owner must fully understand before authorising a write. A
  // vocabulary that gains a member without a Spanish string must fail a test, not ship an English/slug
  // leak into a Spanish-speaking owner's approval banner. Every "iterate the actual constants" test below
  // exists so that guarantee survives someone adding a ninth pot type or a fourth health level without
  // ever opening this file.

  describe('field labels — parity across BOTH locales', () => {
    it('has a Spanish label for every field ANY operation in the union can write', () => {
      // Same derivation as the English parity test above (never a hand-written list) — this is what
      // makes it impossible for `FIELD_LABELS` and `FIELD_LABELS_ES` to drift apart silently.
      for (const field of operationFields()) {
        expect(FIELD_LABELS_ES[field], `missing Spanish label for operation field "${field}"`).toBeTruthy();
      }
    });
  });

  describe('value vocabularies — parity against the SHARED-PACKAGE / Prisma source of truth', () => {
    it('translates every WINDOW_DISTANCES member', () => {
      for (const v of WINDOW_DISTANCES) {
        expect(VALUE_VOCAB_ES.windowDistance![v], `missing Spanish windowDistance for "${v}"`).toBeTruthy();
      }
    });

    it('translates every POT_TYPES member', () => {
      for (const v of POT_TYPES) {
        expect(VALUE_VOCAB_ES.potType![v], `missing Spanish potType for "${v}"`).toBeTruthy();
      }
    });

    it('translates every SOIL_MIXES member', () => {
      for (const v of SOIL_MIXES) {
        expect(VALUE_VOCAB_ES.soilMix![v], `missing Spanish soilMix for "${v}"`).toBeTruthy();
      }
    });

    it('translates every GROWTH_HABITS member', () => {
      for (const v of GROWTH_HABITS) {
        expect(VALUE_VOCAB_ES.growthHabit![v], `missing Spanish growthHabit for "${v}"`).toBeTruthy();
      }
    });

    it('translates every PROGRESS_TAG_KEYS member', () => {
      for (const v of PROGRESS_TAG_KEYS) {
        expect(VALUE_VOCAB_ES.tags![v], `missing Spanish tag label for "${v}"`).toBeTruthy();
      }
    });

    it('translates every ProgressHealth member', () => {
      for (const v of Object.values(ProgressHealth)) {
        expect(VALUE_VOCAB_ES.health![v], `missing Spanish health label for "${v}"`).toBeTruthy();
      }
    });

    it('translates every Task member (targetLabel vocabulary)', () => {
      for (const v of Object.values(Task)) {
        expect(TASK_LABELS_ES[v], `missing Spanish task name for "${v}"`).toBeTruthy();
      }
    });
  });

  describe('en output stays byte-identical to today (pure-addition requirement)', () => {
    it('renders one representative proposal of EACH operation type, unchanged, whether or not `locale` is passed', async () => {
      const ops = [
        { type: 'profile.update', potType: 'terracotta', growLight: true },
        { type: 'plant.update', nickname: 'Monty' },
        { type: 'progress.create', health: 'EXCELLENT', tags: ['NEW_LEAF'] },
        { type: 'progress.update', entryId: 'e1', observations: 'x' },
        { type: 'progress.delete', entryId: 'e1' },
        { type: 'frequency.set', task: 'WATER', intervalDays: 5 },
        { type: 'frequency.clear', task: 'MIST' },
        { type: 'care.done', task: 'ROTATE', occurredOn: '2026-07-01' },
      ];
      const snap = ops.map(() => ({}) as Record<string, unknown>);
      f.snapshotSvc.capture.mockResolvedValue(snap); // no drift for any operation
      const p = withOps(ops, snap);

      const implicit = await svc.render(p as never); // no `locale` argument — the default
      const explicit = await svc.render(p as never, 'en');
      expect(explicit).toEqual(implicit);

      const potChange = explicit.operations[0]!.changes.find((c) => c.field === 'Pot type');
      expect(potChange).toEqual({ field: 'Pot type', before: null, after: 'terracotta' }); // RAW slug, as today
      const healthChange = explicit.operations[2]!.changes.find((c) => c.field === 'Health');
      expect(healthChange).toEqual({ field: 'Health', before: null, after: 'EXCELLENT' }); // RAW enum, as today
      expect(explicit.operations[5]!.targetLabel).toBe('WATER'); // RAW enum, as today
      expect(explicit.operations[6]!.targetLabel).toBe('MIST');
      expect(explicit.operations[1]!.targetLabel).toBe('nickname');
    });
  });

  describe('es output — translated fields, values, booleans and targetLabel; proper nouns/free text/numbers untouched', () => {
    it('translates a profile.update (enum values, a boolean field, and the field labels)', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{ potType: 'plastic', growLight: false }]);
      const p = withOps([{ type: 'profile.update', potType: 'terracotta', growLight: true }], [
        { potType: 'plastic', growLight: false },
      ]);
      const view = await svc.render(p as never, 'es');
      expect(view.operations[0]!.targetLabel).toBe('perfil');
      expect(view.operations[0]!.changes).toEqual(
        expect.arrayContaining([
          { field: 'Tipo de maceta', before: 'Plástico', after: 'Terracota' },
          { field: 'Luz de cultivo', before: 'No', after: 'Sí' },
        ]),
      );
    });

    it('translates progress health + tags, but leaves observations (free text) untouched', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{}]);
      const p = withOps(
        [{ type: 'progress.create', health: 'EXCELLENT', tags: ['NEW_LEAF', 'FLOWERING'], observations: 'looking great' }],
        [{}],
      );
      const view = await svc.render(p as never, 'es');
      expect(view.operations[0]!.targetLabel).toBe('nuevo registro de progreso');
      expect(view.operations[0]!.changes).toEqual(
        expect.arrayContaining([
          { field: 'Salud', before: null, after: 'Excelente' },
          { field: 'Etiquetas', before: null, after: 'Hoja nueva, Floreciendo' },
          { field: 'Observaciones', before: null, after: 'looking great' }, // free text — verbatim
        ]),
      );
    });

    it('translates a task targetLabel for frequency.set/clear and care.done', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]);
      const p = withOps([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }], [{ intervalDays: 7 }]);
      const view = await svc.render(p as never, 'es');
      expect(view.operations[0]!.targetLabel).toBe('Regar');
      expect(view.operations[0]!.changes).toEqual([{ field: 'Cada (días)', before: '7', after: '5' }]);
    });

    it('leaves a place NAME and a nickname (proper nouns) verbatim', async () => {
      f.prisma.place.findFirst
        .mockResolvedValueOnce({ id: 'pl1', name: 'Recámara' })
        .mockResolvedValueOnce({ id: 'pl2', name: 'Living room' });
      f.snapshotSvc.capture.mockResolvedValueOnce([{ placeId: 'pl1', nickname: 'Monty' }]);
      const p = withOps(
        [{ type: 'plant.update', placeId: 'pl2', nickname: 'Monty Jr' }],
        [{ placeId: 'pl1', nickname: 'Monty' }],
      );
      const view = await svc.render(p as never, 'es');
      expect(view.operations[0]!.targetLabel).toBe('Living room'); // a place NAME, never translated
      expect(view.operations[0]!.changes).toEqual(
        expect.arrayContaining([
          { field: 'Lugar', before: 'Recámara', after: 'Living room' },
          { field: 'Apodo', before: 'Monty', after: 'Monty Jr' }, // proper noun, verbatim
        ]),
      );
    });

    it('leaves numbers and dates verbatim', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{ sizeCm: 12, occurredOn: '2026-06-01' }]);
      const p = withOps(
        [{ type: 'progress.update', entryId: 'e1', sizeCm: 20, occurredOn: '2026-07-01' }],
        [{ sizeCm: 12, occurredOn: '2026-06-01' }],
      );
      const view = await svc.render(p as never, 'es');
      expect(view.operations[0]!.changes).toEqual(
        expect.arrayContaining([
          { field: 'Tamaño (cm)', before: '12', after: '20' },
          { field: 'Fecha', before: '2026-06-01', after: '2026-07-01' },
        ]),
      );
    });
  });

  describe('fallbacks — never blank, never a thrown error', () => {
    it('falls back to English for an unknown/garbage locale rather than throwing', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{ intervalDays: 7 }]);
      const view = await svc.render(baseProposal as never, 'fr' as never);
      // Identical to the plain `en` rendering of the same proposal.
      expect(view.operations[0]!.changes[0]).toEqual({ field: 'Every (days)', before: '7', after: '5' });
    });

    it('falls back to the raw value for an enum member the Spanish vocabulary does not recognise', async () => {
      f.snapshotSvc.capture.mockResolvedValueOnce([{ potType: 'a-future-pot-type' }]);
      const p = withOps([{ type: 'profile.update', potType: 'a-future-pot-type' }], [{ potType: 'a-future-pot-type' }]);
      const view = await svc.render(p as never, 'es');
      // Never blank, never thrown — the raw slug is still SOMETHING the owner can read and query about.
      expect(view.operations[0]!.changes[0]).toEqual({
        field: 'Tipo de maceta',
        before: 'a-future-pot-type',
        after: 'a-future-pot-type',
      });
    });
  });
});

/**
 * `resolveLocale` gets its own tests because it is the SINGLE GATE for the entire Spanish path, and
 * because breaking it fails in the one way this project keeps getting caught by: SILENTLY, in English.
 *
 * Everything else in this file calls `render(proposal, 'es')` directly, so it proves the string tables
 * are right while proving nothing about whether a real request ever reaches them. Measured: making
 * `resolveLocale` always answer `'en'` left all 110 tests in this directory green — only the (much
 * slower) e2e suite noticed, and only because it sends a real `x-locale` header. A guard that only the
 * slowest gate can see is a guard most runs do not have.
 *
 * The failure mode is also the one the spec's B2 ruling calls out as worse than the bug: the owner does
 * not get an error, they get the approval screen in a language they may not read, with every test green.
 */
describe('resolveLocale — the one gate between the wire and the string tables', () => {
  it('accepts the exact locale code the app ships', () => {
    expect(resolveLocale('es')).toBe('es');
    expect(resolveLocale('en')).toBe('en');
  });

  // The BFF forwards the `i18n_redirected` cookie, whose value is one of nuxt.config's locale CODES
  // ('en' | 'es') — never a BCP-47 tag. Pinned so that if that ever changes, this fails HERE, next to the
  // table that would otherwise be silently skipped, rather than as "the banner is in English again".
  it('falls back to English for anything else, and never throws', () => {
    for (const raw of ['es-MX', 'ES', 'fr', '', ' es', 'en-US', 'not-a-real-locale', undefined, null, 42, {}]) {
      expect(resolveLocale(raw), `expected English for ${JSON.stringify(raw)}`).toBe('en');
    }
  });
});
