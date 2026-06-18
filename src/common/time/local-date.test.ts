import { describe, expect, it } from 'vitest';
import { startOfTodayUtc, startOfTomorrowUtc } from './local-date.js';

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
