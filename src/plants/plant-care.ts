import { dayDiff } from '../common/time/local-date.js';

export type CareStatus = 'overdue' | 'today' | 'upcoming';

// Pure: daysUntilDue/status of a @db.Date due relative to startOfTodayUtc(tz). Computed on the
// backend so the client never subtracts a UTC-midnight date from a local now (off-by-one at midnight).
export function careTaskStatus(
  nextDueOn: Date,
  startOfToday: Date,
): { daysUntilDue: number; status: CareStatus } {
  const daysUntilDue = dayDiff(nextDueOn, startOfToday);
  const status: CareStatus = daysUntilDue < 0 ? 'overdue' : daysUntilDue === 0 ? 'today' : 'upcoming';
  return { daysUntilDue, status };
}
