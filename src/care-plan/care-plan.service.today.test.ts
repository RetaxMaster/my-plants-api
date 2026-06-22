import { describe, expect, it } from 'vitest';
import { CarePlanService } from './care-plan.service.js';

it('todaysTasks applies each plant own place-city timezone', async () => {
  // now = 02:00Z on 2026-06-21. In UTC the local date is the 21st (tomorrow = 06-22);
  // in America/Mexico_City (UTC-6) it is still the 20th (tomorrow = 06-21).
  const now = new Date('2026-06-21T02:00:00Z');
  const dueOn = new Date(Date.UTC(2026, 5, 21)); // 2026-06-21 UTC midnight (a @db.Date value)
  const rows = [
    { plantId: 'a', task: 'WATER', nextDueOn: dueOn, plant: { place: { city: { timezone: 'UTC' } } } },
    { plantId: 'b', task: 'WATER', nextDueOn: dueOn, plant: { place: { city: { timezone: 'America/Mexico_City' } } } },
  ];
  const prisma = { dueCache: { findMany: async () => rows } } as any;
  const svc = new CarePlanService(prisma, {} as any);
  const out = await svc.todaysTasks('owner-1', now);
  // 'a' is due today in UTC; 'b' is "tomorrow" in Mexico City → excluded.
  expect(out.map((r) => r.plantId)).toEqual(['a']);
  expect(out[0]).not.toHaveProperty('plant'); // nested join data is stripped from the result
});
