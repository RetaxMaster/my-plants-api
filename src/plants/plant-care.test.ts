import { describe, expect, it } from 'vitest';
import { careTaskStatus } from './plant-care.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('careTaskStatus', () => {
  const today = day('2026-06-20'); // startOfTodayUtc(tz) result

  it('marks a past due date as overdue with a negative count', () => {
    expect(careTaskStatus(day('2026-06-18'), today)).toEqual({ daysUntilDue: -2, status: 'overdue' });
  });

  it('marks the same day as today with zero', () => {
    expect(careTaskStatus(day('2026-06-20'), today)).toEqual({ daysUntilDue: 0, status: 'today' });
  });

  it('marks a future due date as upcoming with a positive count', () => {
    expect(careTaskStatus(day('2026-06-25'), today)).toEqual({ daysUntilDue: 5, status: 'upcoming' });
  });
});
