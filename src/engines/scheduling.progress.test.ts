import { describe, expect, it } from 'vitest';
import { computeProgressDue } from './scheduling.js';

// Helper: a UTC-midnight @db.Date for a given calendar day.
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const dow = (x: Date) => x.getUTCDay(); // 0=Sun .. 1=Mon

describe('computeProgressDue', () => {
  it('from a Tuesday returns that same week\'s Monday? no — the NEXT Monday (6 days later)', () => {
    // 2026-06-30 is a Tuesday.
    const due = computeProgressDue(d('2026-06-30'));
    expect(due).toEqual(d('2026-07-06'));
    expect(dow(due)).toBe(1);
  });

  it('from a Sunday returns the very next day (Monday)', () => {
    // 2026-07-05 is a Sunday.
    const due = computeProgressDue(d('2026-07-05'));
    expect(due).toEqual(d('2026-07-06'));
  });

  it('from a Monday returns the FOLLOWING Monday (strictly after, no same-day)', () => {
    // 2026-07-06 is a Monday.
    const due = computeProgressDue(d('2026-07-06'));
    expect(due).toEqual(d('2026-07-13'));
  });

  it('from a Saturday returns the next Monday (2 days later)', () => {
    // 2026-07-04 is a Saturday.
    const due = computeProgressDue(d('2026-07-04'));
    expect(due).toEqual(d('2026-07-06'));
  });

  it('is DATE-granular and UTC-safe: the result is always UTC-midnight on a Monday', () => {
    for (const day of ['2026-01-01', '2026-02-14', '2026-12-31', '2027-03-08']) {
      const due = computeProgressDue(d(day));
      expect(dow(due)).toBe(1);
      expect(due.getUTCHours()).toBe(0);
      expect(due.getUTCMinutes()).toBe(0);
    }
  });
});
