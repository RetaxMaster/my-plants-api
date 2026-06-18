import { describe, expect, it } from 'vitest';
import { seasonForDate } from './season.js';

describe('seasonForDate (northern hemisphere)', () => {
  it('maps months to meteorological seasons', () => {
    expect(seasonForDate(new Date('2026-01-15'), 'north')).toBe('winter');
    expect(seasonForDate(new Date('2026-04-15'), 'north')).toBe('spring');
    expect(seasonForDate(new Date('2026-07-15'), 'north')).toBe('summer');
    expect(seasonForDate(new Date('2026-10-15'), 'north')).toBe('autumn');
  });
  it('flips for the southern hemisphere', () => {
    expect(seasonForDate(new Date('2026-01-15'), 'south')).toBe('summer');
    expect(seasonForDate(new Date('2026-07-15'), 'south')).toBe('winter');
  });
});
