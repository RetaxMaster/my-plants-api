// All day boundaries use the owner's primary-city timezone. Due dates are DATE granularity,
// so we represent a local calendar day as that day's UTC-midnight Date (matching how Prisma
// returns @db.Date columns) and never compare against toISOString() strings of timestamps.
interface Ymd { y: number; m: number; d: number }

function localYmd(now: Date, timeZone: string): Ymd {
  // en-CA formats as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = parts.split('-').map(Number);
  return { y, m, d };
}

export function startOfTodayUtc(timeZone: string, now: Date = new Date()): Date {
  const { y, m, d } = localYmd(now, timeZone);
  return new Date(Date.UTC(y, m - 1, d));
}

export function startOfTomorrowUtc(timeZone: string, now: Date = new Date()): Date {
  const { y, m, d } = localYmd(now, timeZone);
  return new Date(Date.UTC(y, m - 1, d + 1));
}

// Integer day count between two @db.Date (UTC-midnight) values: round((a - b) / 86_400_000).
// Signed (a before b → negative). Never uses toISOString — the MariaDB date rule. round() absorbs
// any sub-day skew (e.g. a value stored a few hours off midnight) into the nearest whole day.
export function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}
