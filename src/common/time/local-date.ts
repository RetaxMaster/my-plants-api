// All day boundaries use the timezone of each plant's place-city (Moving still uses the primary
// flag, but the day cutoff does not). Due dates are DATE granularity,
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

// Parse a YYYY-MM-DD (a journal/care date) into the UTC-midnight Date that a @db.Date column stores.
// Binds a NATIVE Date — never an ISO/toISOString string (the MariaDB date rule). The ORM stringifies
// this in the connection timezone; UTC-midnight keeps DATE granularity stable.
export function ymdToUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Render a @db.Date (UTC-midnight) as YYYY-MM-DD from its UTC calendar parts. Single source: reused
// by plants + progress responses (no per-service fork).
export function ymdFromUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
