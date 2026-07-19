import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Task, ProgressHealth } from '@prisma/client';
import { PROGRESS_TAG_KEYS } from '@retaxmaster/my-plants-species-schema';
import {
  createProposalSchema,
  assertNoOverlappingWriteSets,
  assertSerializedBound,
  MAX_SERIALIZED_BYTES,
} from './proposal-operations.schema.js';

const ok = (ops: unknown[]) => createProposalSchema.safeParse({ summary: 'do a thing', operations: ops });

// ─── Vocabulary parity ──────────────────────────────────────────────────────────
// These tests are the whole reason the schema DERIVES its literals instead of hand-authoring them.
// A hand-written enum here is how the API ends up validating a vocabulary the DB and the agent do
// not share; if someone adds a Task or a ProgressHealth value, these go red on purpose.
describe('operation vocabulary parity with the canonical sources', () => {
  it('accepts every frequency-bearing Task from the Prisma enum, and rejects PROGRESS', () => {
    for (const t of Object.values(Task)) {
      const accepted = ok([{ type: 'frequency.clear', task: t }]).success;
      expect(accepted).toBe(t !== Task.PROGRESS);
    }
  });

  it('accepts every ProgressHealth value from the Prisma enum, and nothing else', () => {
    for (const h of Object.values(ProgressHealth)) {
      expect(ok([{ type: 'progress.create', health: h }]).success).toBe(true);
    }
    // The values an earlier draft of this plan invented. They are NOT in the schema.
    for (const bogus of ['THRIVING', 'STRUGGLING', 'CRITICAL']) {
      expect(ok([{ type: 'progress.create', health: bogus }]).success).toBe(false);
    }
  });

  it('accepts only catalog tag keys — tags are a closed vocabulary, not free strings', () => {
    expect(ok([{ type: 'progress.create', health: 'GOOD', tags: [...PROGRESS_TAG_KEYS] }]).success).toBe(true);
    expect(ok([{ type: 'progress.create', health: 'GOOD', tags: ['NOT_A_REAL_TAG'] }]).success).toBe(false);
  });

  it('accepts only the shared package profile vocabulary, which is lower-kebab', () => {
    // The profile enums live in @retaxmaster/my-plants-species-schema and are lower-kebab
    // ('plastic', 'on-sill'). An upper-cased literal is NOT in the vocabulary — asserting that here
    // is what stops a second, drifting profile contract from being hand-authored in this file.
    expect(ok([{ type: 'profile.update', potType: 'plastic' }]).success).toBe(true);
    expect(ok([{ type: 'profile.update', potType: 'PLASTIC' }]).success).toBe(false);
    expect(ok([{ type: 'profile.update', windowDistance: 'on-sill' }]).success).toBe(true);
    expect(ok([{ type: 'profile.update', potType: null }]).success).toBe(true); // clearing is legal
  });

  it('mirrors the existing progress DTO bounds', () => {
    expect(ok([{ type: 'progress.create', health: 'GOOD', observations: 'x'.repeat(2000) }]).success).toBe(true);
    expect(ok([{ type: 'progress.create', health: 'GOOD', observations: 'x'.repeat(2001) }]).success).toBe(false);
    expect(ok([{ type: 'progress.create', health: 'GOOD', sizeCm: 2_147_483_648 }]).success).toBe(false);
  });
});

describe('operations union', () => {
  it('accepts each of the eight operation types', () => {
    expect(ok([{ type: 'profile.update', potType: 'plastic' }]).success).toBe(true);
    expect(ok([{ type: 'plant.update', nickname: 'Randy' }]).success).toBe(true);
    expect(ok([{ type: 'progress.create', health: 'GOOD', occurredOn: '2026-07-18' }]).success).toBe(true);
    expect(ok([{ type: 'progress.update', entryId: 'e1', observations: 'ok' }]).success).toBe(true);
    expect(ok([{ type: 'progress.delete', entryId: 'e1' }]).success).toBe(true);
    expect(ok([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]).success).toBe(true);
    expect(ok([{ type: 'frequency.clear', task: 'WATER' }]).success).toBe(true);
    expect(ok([{ type: 'care.done', task: 'WATER', occurredOn: '2026-07-18' }]).success).toBe(true);
  });

  it('rejects an unknown operation type and an unknown property', () => {
    expect(ok([{ type: 'plant.delete' }]).success).toBe(false);
    expect(ok([{ type: 'progress.delete', entryId: 'e1', extra: 1 }]).success).toBe(false);
    expect(ok([{ type: 'profile.update', potType: 'plastic', extra: 1 }]).success).toBe(false);
  });

  it('rejects an operation that names a target but changes nothing', () => {
    expect(ok([{ type: 'profile.update' }]).success).toBe(false);
    expect(ok([{ type: 'plant.update' }]).success).toBe(false);
    expect(ok([{ type: 'progress.update', entryId: 'e1' }]).success).toBe(false);
  });

  it('rejects any top-level property beyond summary and operations', () => {
    const r = createProposalSchema.safeParse({
      summary: 's',
      operations: [{ type: 'frequency.clear', task: 'WATER' }],
      sessionId: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('enforces the clear-token rules', () => {
    expect(ok([{ type: 'progress.update', entryId: 'e1', observations: null }]).success).toBe(true);
    expect(ok([{ type: 'progress.update', entryId: 'e1', sizeCm: null }]).success).toBe(true);
    expect(ok([{ type: 'plant.update', nickname: null }]).success).toBe(true);
    expect(ok([{ type: 'progress.update', entryId: 'e1', tags: [] }]).success).toBe(true);
    expect(ok([{ type: 'progress.update', entryId: 'e1', tags: null }]).success).toBe(false);
    expect(ok([{ type: 'progress.update', entryId: 'e1', health: null }]).success).toBe(false);
    expect(ok([{ type: 'progress.update', entryId: 'e1', occurredOn: null }]).success).toBe(false);
  });

  it('rejects an ISO instant where a calendar date is required', () => {
    expect(ok([{ type: 'care.done', task: 'WATER', occurredOn: '2026-07-18T00:00:00.000Z' }]).success).toBe(false);
  });

  it('enforces the size bounds', () => {
    expect(
      createProposalSchema.safeParse({
        summary: 'x'.repeat(501),
        operations: [{ type: 'frequency.clear', task: 'WATER' }],
      }).success,
    ).toBe(false);
    const eleven = Array.from({ length: 11 }, () => ({ type: 'frequency.clear', task: 'WATER' }));
    expect(ok(eleven).success).toBe(false);
    expect(ok([]).success).toBe(false);
  });

  it('enforces the 64 KB serialized bound at the boundary, for operations AND snapshot', () => {
    // Spec §5.5.1: "serialized `operations` + `snapshot` ≤ 64 KB EACH". This is a SEPARATE limit from
    // the ≤ 10 operation count — ten operations are easily enough to exceed 64 KB via a long
    // `observations` — so an agent could otherwise use the proposal row as unbounded storage while
    // passing every count-based check. Boundary-tested at the limit and one byte over.
    // Build a payload whose SERIALIZED size is exactly `target`. `JSON.stringify({ a: '<n chars>' })`
    // is `{"a":"…"}` — an 8-byte envelope around the string — so the padding is `target - 8`. The
    // envelope is computed, not assumed: the assertion below proves each fixture is the intended size,
    // which is what makes this a real boundary test. Approximate fixtures ("a bit under", "a bit over")
    // cannot distinguish `>` from `>=`, and an off-by-one there silently rejects a legal proposal — or
    // accepts an illegal one — at exactly the size a real payload is most likely to land on.
    const sized = (target: number) => {
      const value = { a: 'x'.repeat(target - 8) };
      expect(Buffer.byteLength(JSON.stringify(value))).toBe(target); // the fixture is exact, or the test is void
      return value;
    };

    const atLimit = sized(MAX_SERIALIZED_BYTES); // exactly 64 KB — must be ACCEPTED
    const overLimit = sized(MAX_SERIALIZED_BYTES + 1); // exactly one byte over — must be REJECTED

    expect(() => assertSerializedBound(atLimit, 'operations')).not.toThrow();
    expect(() => assertSerializedBound(atLimit, 'snapshot')).not.toThrow();
    expect(() => assertSerializedBound(overLimit, 'operations')).toThrow(/operations exceeds/);
    expect(() => assertSerializedBound(overLimit, 'snapshot')).toThrow(/snapshot exceeds/);

    // And it is a 400, not a 500 — the agent must get an actionable error it can shrink and retry.
    expect.assertions(9); // the 2 fixture-size proofs + 4 bound checks + this block's 3
    try {
      assertSerializedBound(overLimit, 'operations');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as { status?: number }).status).toBe(400);
      expect((e as Error).message).toContain(String(MAX_SERIALIZED_BYTES));
    }
  });

  it('rejects overlapping write-sets', () => {
    expect(() =>
      assertNoOverlappingWriteSets([
        { type: 'profile.update', potType: 'plastic' } as never,
        { type: 'profile.update', potType: 'terracotta' } as never,
      ]),
    ).toThrow();
    expect(() =>
      assertNoOverlappingWriteSets([
        { type: 'progress.update', entryId: 'e1', observations: 'a' } as never,
        { type: 'progress.delete', entryId: 'e1' } as never,
      ]),
    ).toThrow();
    expect(() =>
      assertNoOverlappingWriteSets([
        { type: 'progress.update', entryId: 'e1', observations: 'a' } as never,
        { type: 'progress.update', entryId: 'e2', observations: 'b' } as never,
      ]),
    ).not.toThrow();
  });
});
