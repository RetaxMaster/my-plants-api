import { describe, expect, it } from 'vitest';
import { computeAdherence, eligibleCycles, type AdherencePayload } from './adherence.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('computeAdherence', () => {
  it('builds an eligible adherence record for a normal cycle', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-20'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: day('2026-06-23'),
      hadOverride: false,
    });
    expect(a).toEqual({
      previousAnchorOn: day('2026-06-13'),
      scheduledDueOn: day('2026-06-23'),
      observedDays: 7,
      scheduledDays: 10,
      eligible: true,
    });
  });

  it('is ineligible when an override was active (postponed cycle)', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-20'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: day('2026-06-23'),
      hadOverride: true,
    });
    expect(a?.eligible).toBe(false);
  });

  it('is ineligible for a same-day / back-dated DONE (observedDays < 1)', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-13'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: day('2026-06-23'),
      hadOverride: false,
    });
    expect(a?.eligible).toBe(false);
  });

  it('is ineligible when scheduledDays < 1', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-20'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: day('2026-06-13'),
      hadOverride: false,
    });
    expect(a?.eligible).toBe(false);
  });

  it('returns null when there is no due-cache row (scheduledDueOn = null)', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-20'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: null,
      hadOverride: false,
    });
    expect(a).toBeNull();
  });

  it('clamps the anchor so it is never after the event (first watering before acquisition)', () => {
    const a = computeAdherence({
      occurredOn: day('2026-07-07'),
      previousAnchor: day('2026-07-08'), // acquisition fallback, AFTER the event
      scheduledDueOn: day('2026-07-15'),
      hadOverride: false,
    });
    expect(a?.previousAnchorOn).toEqual(day('2026-07-07')); // clamped to the event date, never after it
    expect(a?.observedDays).toBe(0); // no longer -1
    expect(a?.eligible).toBe(false); // still ineligible — no eligible cycle is created by the clamp
  });

  it('leaves a normal (anchor before event) cycle untouched', () => {
    const a = computeAdherence({
      occurredOn: day('2026-06-20'),
      previousAnchor: day('2026-06-13'),
      scheduledDueOn: day('2026-06-23'),
      hadOverride: false,
    });
    expect(a?.previousAnchorOn).toEqual(day('2026-06-13'));
    expect(a?.observedDays).toBe(7);
    expect(a?.eligible).toBe(true);
  });
});

describe('eligibleCycles', () => {
  it('keeps only eligible adherence payloads, in input order (newest first)', () => {
    const payloads: (AdherencePayload | undefined)[] = [
      { previousAnchorOn: day('2026-06-13'), scheduledDueOn: day('2026-06-23'), observedDays: 7, scheduledDays: 10, eligible: true },
      undefined,
      { previousAnchorOn: day('2026-06-01'), scheduledDueOn: day('2026-06-11'), observedDays: 6, scheduledDays: 10, eligible: false },
      { previousAnchorOn: day('2026-05-20'), scheduledDueOn: day('2026-05-30'), observedDays: 8, scheduledDays: 10, eligible: true },
    ];
    expect(eligibleCycles(payloads)).toEqual([
      { observedDays: 7, scheduledDays: 10 },
      { observedDays: 8, scheduledDays: 10 },
    ]);
  });
});
