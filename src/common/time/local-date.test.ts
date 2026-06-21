import { describe, expect, it } from 'vitest';
import { startOfTodayUtc, startOfTomorrowUtc, dayDiff } from './local-date.js';

describe('timezone-aware local-date boundaries', () => {
  // 02:00Z on 2026-06-18 is still 2026-06-17 in America/Mexico_City (UTC-6).
  const now = new Date('2026-06-18T02:00:00Z');

  it('computes the start of the local day as a UTC-midnight Date', () => {
    expect(startOfTodayUtc('America/Mexico_City', now).toISOString()).toBe('2026-06-17T00:00:00.000Z');
  });

  it('computes the start of the next local day', () => {
    expect(startOfTomorrowUtc('America/Mexico_City', now).toISOString()).toBe('2026-06-18T00:00:00.000Z');
  });

  it('uses the local calendar day for a positive-offset zone', () => {
    expect(startOfTodayUtc('Asia/Tokyo', now).toISOString()).toBe('2026-06-18T00:00:00.000Z');
  });
});

describe('dayDiff on @db.Date (UTC-midnight) values', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('counts whole days between two UTC-midnight dates', () => {
    expect(dayDiff(day('2026-06-20'), day('2026-06-13'))).toBe(7);
  });

  it('is signed: a before b yields a negative count', () => {
    expect(dayDiff(day('2026-06-13'), day('2026-06-20'))).toBe(-7);
  });

  it('returns 0 for the same calendar day', () => {
    expect(dayDiff(day('2026-06-20'), day('2026-06-20'))).toBe(0);
  });

  it('rounds across a DST-style sub-day skew to the nearest whole day', () => {
    // Even if a stored value is off by a few hours, round() snaps to the day count.
    expect(dayDiff(new Date('2026-06-20T01:00:00.000Z'), day('2026-06-13'))).toBe(7);
  });
});
