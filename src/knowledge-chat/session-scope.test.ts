import { describe, expect, it } from 'vitest';
import { sessionMatchesScope, whereForScope } from './session-scope.js';

describe('whereForScope', () => {
  it('KNOWLEDGE → kind-only filter', () => {
    expect(whereForScope({ kind: 'KNOWLEDGE' })).toEqual({ kind: 'KNOWLEDGE' });
  });

  it('DOCTOR → the (kind, plantId, ownerId) access boundary', () => {
    expect(whereForScope({ kind: 'DOCTOR', plantId: 'p1', ownerId: 'o1' })).toEqual({
      kind: 'DOCTOR',
      plantId: 'p1',
      ownerId: 'o1',
    });
  });
});

describe('sessionMatchesScope', () => {
  it('KNOWLEDGE scope matches only kind===KNOWLEDGE rows', () => {
    expect(sessionMatchesScope({ kind: 'KNOWLEDGE', plantId: null, ownerId: null }, { kind: 'KNOWLEDGE' })).toBe(
      true,
    );
    expect(sessionMatchesScope({ kind: 'DOCTOR', plantId: 'p1', ownerId: 'o1' }, { kind: 'KNOWLEDGE' })).toBe(
      false,
    );
  });

  it('DOCTOR scope matches only when kind, plantId, and ownerId all equal', () => {
    const scope = { kind: 'DOCTOR' as const, plantId: 'p1', ownerId: 'o1' };
    expect(sessionMatchesScope({ kind: 'DOCTOR', plantId: 'p1', ownerId: 'o1' }, scope)).toBe(true);
  });

  it('DOCTOR scope: mismatched plantId → false', () => {
    const scope = { kind: 'DOCTOR' as const, plantId: 'p1', ownerId: 'o1' };
    expect(sessionMatchesScope({ kind: 'DOCTOR', plantId: 'OTHER', ownerId: 'o1' }, scope)).toBe(false);
  });

  it('DOCTOR scope: mismatched ownerId → false', () => {
    const scope = { kind: 'DOCTOR' as const, plantId: 'p1', ownerId: 'o1' };
    expect(sessionMatchesScope({ kind: 'DOCTOR', plantId: 'p1', ownerId: 'OTHER' }, scope)).toBe(false);
  });

  it('a KNOWLEDGE row under a DOCTOR scope → false', () => {
    const scope = { kind: 'DOCTOR' as const, plantId: 'p1', ownerId: 'o1' };
    expect(sessionMatchesScope({ kind: 'KNOWLEDGE', plantId: null, ownerId: null }, scope)).toBe(false);
  });
});
