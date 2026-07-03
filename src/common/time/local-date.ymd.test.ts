import { describe, expect, it } from 'vitest';
import { ymdToUtcDate, ymdFromUtcDate } from './local-date.js';

describe('ymdToUtcDate / ymdFromUtcDate', () => {
  it('parses a YYYY-MM-DD into a UTC-midnight Date (native Date, no ISO-string comparison)', () => {
    const d = ymdToUtcDate('2026-07-06');
    expect(d.getTime()).toBe(Date.UTC(2026, 6, 6));
    expect(d.getUTCHours()).toBe(0);
  });

  it('round-trips a @db.Date UTC-midnight value back to YYYY-MM-DD', () => {
    expect(ymdFromUtcDate(new Date(Date.UTC(2026, 0, 3)))).toBe('2026-01-03');
    expect(ymdFromUtcDate(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });
});
