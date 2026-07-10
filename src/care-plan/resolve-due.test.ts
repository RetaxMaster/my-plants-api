import { describe, it, expect } from 'vitest';
import type { Task } from '@prisma/client';
import { resolveDue } from './resolve-due.js';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString();

describe('resolveDue — per-task replace-vs-floor, encoded not forked (spec F3.1)', () => {
  it('REPOT: the override is a FLOOR — max(computed, override); it pushes forward, never pins backward', () => {
    // computed LATER than the snooze -> the engine wins (the snooze does NOT mask it)
    expect(iso(resolveDue('REPOT', d('2026-06-01'), d('2026-03-01')))).toBe(iso(d('2026-06-01')));
    // computed EARLIER than the snooze -> the floor holds the date forward
    expect(iso(resolveDue('REPOT', d('2026-02-01'), d('2026-03-01')))).toBe(iso(d('2026-03-01')));
  });

  it('REPOT: a +1-day could-not-check snooze can never pin a far-future computed date', () => {
    // The everyday failure the floor exists to prevent: under REPLACE this returns tomorrow, forever.
    const tomorrow = d('2026-01-02');
    const computed = d('2027-12-25');
    expect(iso(resolveDue('REPOT', computed, tomorrow))).toBe(iso(computed));
  });

  it('REPOT with no override -> the computed date, unchanged (and the SAME object)', () => {
    const computed = d('2026-06-01');
    expect(resolveDue('REPOT', computed, null)).toBe(computed);
    expect(resolveDue('REPOT', computed, undefined)).toBe(computed);
  });

  it('REPOT: equal dates return the computed date (the floor is not strictly greater)', () => {
    const same = d('2026-06-01');
    expect(iso(resolveDue('REPOT', same, d('2026-06-01')))).toBe(iso(same));
  });

  it('WATER: the override REPLACES — the shipped semantics are preserved exactly, BOTH directions', () => {
    // an override EARLIER than computed: replace keeps the owner's date. A floor would return computed,
    // silently ignoring the snooze — which is why the two rules cannot be collapsed into max().
    expect(iso(resolveDue('WATER', d('2026-06-01'), d('2026-03-01')))).toBe(iso(d('2026-03-01')));
    // an override LATER than computed: replace also keeps the owner's date.
    expect(iso(resolveDue('WATER', d('2026-02-01'), d('2026-03-01')))).toBe(iso(d('2026-03-01')));
  });

  it('WATER with no override -> the computed date', () => {
    expect(iso(resolveDue('WATER', d('2026-06-01'), null))).toBe(iso(d('2026-06-01')));
  });

  it('every non-REPOT task uses REPLACE (one rule, dispatched by task — never two meanings per column)', () => {
    for (const t of ['FERTILIZE', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS'] as Task[]) {
      expect(iso(resolveDue(t, d('2026-06-01'), d('2026-03-01')))).toBe(iso(d('2026-03-01')));
      expect(iso(resolveDue(t, d('2026-02-01'), d('2026-03-01')))).toBe(iso(d('2026-03-01')));
    }
  });

  it('REPOT and WATER genuinely DISAGREE on the same inputs (the dispatch is observable, not decorative)', () => {
    const computed = d('2026-06-01');
    const override = d('2026-03-01');
    expect(iso(resolveDue('REPOT', computed, override))).not.toBe(iso(resolveDue('WATER', computed, override)));
  });
});
