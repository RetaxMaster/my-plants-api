import { describe, expect, it } from 'vitest';
import { latestSizedHeight } from './latest-sized-height.js';

// The ONE definition of "the plant's height", shared by the care engine, the plant read model, and the
// care read model. These tests pin the two conventions a copy could not keep (spec E, Area A).
const NOW = new Date('2026-07-09T12:00:00Z');
const fakePrisma = (row: { sizeCm: number | null; occurredOn: Date } | null) => ({
  plantProgressEntry: {
    findFirst: async (args: unknown) => {
      captured = args;
      return row;
    },
  },
}) as never;
let captured: unknown;

describe('latestSizedHeight', () => {
  it('returns null when the plant has never been measured', async () => {
    expect(await latestSizedHeight(fakePrisma(null), 'p1', NOW)).toBeNull();
  });

  it('filters to SIZE-BEARING entries, so a later note-only entry never blanks a real height', async () => {
    await latestSizedHeight(fakePrisma({ sizeCm: 40, occurredOn: NOW }), 'p1', NOW);
    expect(captured).toMatchObject({ where: { plantId: 'p1', sizeCm: { not: null } } });
  });

  it('uses the canonical occurredOn desc, createdAt desc tiebreak', async () => {
    await latestSizedHeight(fakePrisma({ sizeCm: 40, occurredOn: NOW }), 'p1', NOW);
    expect(captured).toMatchObject({ orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }] });
  });

  it('measures age from occurredOn in whole days, and returns the measurement day itself', async () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000);
    expect(await latestSizedHeight(fakePrisma({ sizeCm: 55, occurredOn: tenDaysAgo }), 'p1', NOW))
      .toEqual({ heightCm: 55, heightAgeDays: 10, measuredOn: tenDaysAgo });
  });

  it('floors a future-dated measurement at age 0 rather than going negative', async () => {
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(await latestSizedHeight(fakePrisma({ sizeCm: 55, occurredOn: tomorrow }), 'p1', NOW))
      .toEqual({ heightCm: 55, heightAgeDays: 0, measuredOn: tomorrow });
  });

  it('measuredOn is the entry occurredOn, NOT "now" — Spec F persists it as heightMeasuredOn', async () => {
    // The REPOT inspection payload snapshots this (F5.3): sigma_obs's age term and the calibration routing
    // both mean the HEIGHT MEASUREMENT's age, not the inspection event's. A fork that re-queried the entry
    // (or that stamped `new Date()`) would silently make a two-year-old height look fresh.
    const measured = new Date('2024-03-04T00:00:00.000Z');
    const got = await latestSizedHeight(fakePrisma({ sizeCm: 55, occurredOn: measured }), 'p1', NOW);
    expect(got?.measuredOn.toISOString()).toBe('2024-03-04T00:00:00.000Z');
    expect(got?.measuredOn.getTime()).not.toBe(NOW.getTime());
  });

  it('treats a row whose sizeCm is somehow null as "no height" rather than crashing', async () => {
    expect(await latestSizedHeight(fakePrisma({ sizeCm: null, occurredOn: NOW }), 'p1', NOW)).toBeNull();
  });
});
