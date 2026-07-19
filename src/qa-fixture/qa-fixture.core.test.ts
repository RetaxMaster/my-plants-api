import { describe, expect, it } from 'vitest';
import { PROGRESS_TAG_KEYS } from '@retaxmaster/my-plants-species-schema/progress-tag-constants';
import { assertDevelopmentEnv, EnvironmentGuardError } from './qa-fixture.guard.js';
import { daysAgoUtc, resolveSpecies, SCENARIO } from './qa-fixture.core.js';

describe('the environment guard', () => {
  it('allows an explicit development environment', () => {
    expect(() => assertDevelopmentEnv({ APP_ENV: 'development' })).not.toThrow();
  });

  // The whole point of the guard. Each of these is a way a real machine ends up unlabelled, and every
  // one of them must REFUSE — a destructive script that runs when configuration is missing is not
  // guarded at all.
  it.each([
    ['production', { APP_ENV: 'production' }],
    ['unset', {}],
    ['empty', { APP_ENV: '' }],
    ['a typo', { APP_ENV: 'develpment' }],
    ['a near-miss', { APP_ENV: 'dev' }],
    ['differently cased', { APP_ENV: 'Development' }],
  ])('refuses when APP_ENV is %s', (_label, env) => {
    expect(() => assertDevelopmentEnv(env as NodeJS.ProcessEnv)).toThrow(EnvironmentGuardError);
  });

  it('names the offending value so the operator knows why it refused', () => {
    expect(() => assertDevelopmentEnv({ APP_ENV: 'staging' })).toThrow(/staging/);
    expect(() => assertDevelopmentEnv({})).toThrow(/<unset>/);
  });
});

describe('relative dates', () => {
  const anchor = new Date('2026-07-19T18:30:00.000Z');

  it('lands on UTC midnight regardless of the anchor time of day', () => {
    const d = daysAgoUtc(anchor, 0);
    expect(d.toISOString()).toBe('2026-07-19T00:00:00.000Z');
  });

  it('counts calendar days back', () => {
    expect(daysAgoUtc(anchor, 60).toISOString()).toBe('2026-05-20T00:00:00.000Z');
  });

  // A fixture whose dates drift across a DST boundary silently stops meaning what it says: "60 days
  // overdue" quietly becomes 59 or 61 and a threshold test flips. Epoch arithmetic from a UTC-midnight
  // anchor is what makes that impossible, so it is asserted directly rather than inferred.
  it('is unaffected by a DST transition in the local zone', () => {
    const beforeDst = new Date('2026-11-05T12:00:00.000Z');
    const crossed = daysAgoUtc(beforeDst, 14);
    expect(crossed.getUTCHours()).toBe(0);
    expect(crossed.toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });
});

describe('species resolution', () => {
  const available = ['epipremnum-aureum', 'dracaena-trifasciata', 'nephrolepis-exaltata', 'dracaena-fragrans'];

  it('uses each preferred species when it exists', () => {
    const { bySpecKey, fallbacks } = resolveSpecies(SCENARIO, available);
    expect(fallbacks).toEqual([]);
    for (const spec of SCENARIO) {
      expect(bySpecKey.get(spec.key)).toBe(spec.preferredSpecies);
    }
  });

  it('substitutes a real species when the preferred one is absent, and reports it', () => {
    const { bySpecKey, fallbacks } = resolveSpecies(SCENARIO, ['epipremnum-aureum']);
    for (const spec of SCENARIO) {
      expect(bySpecKey.get(spec.key)).toBe('epipremnum-aureum');
    }
    // Silence here would leave QA reasoning about a plant that is not the one in front of them.
    expect(fallbacks.length).toBe(SCENARIO.length - 1);
    expect(fallbacks.join(' ')).toMatch(/not present, using/);
  });

  it('refuses to build against an empty species table rather than inventing one', () => {
    expect(() => resolveSpecies(SCENARIO, [])).toThrow(/knowledge engine/);
  });
});

describe('the scenario', () => {
  it('gives every plant a distinct key and nickname', () => {
    expect(new Set(SCENARIO.map((p) => p.key)).size).toBe(SCENARIO.length);
    expect(new Set(SCENARIO.map((p) => p.nickname)).size).toBe(SCENARIO.length);
  });

  // These are the four surfaces the scenario exists to cover. If a future edit drops one, QA loses that
  // case silently — the fixture would still build, it would just stop testing something.
  it('covers an empty profile, a complete one and a partial one', () => {
    const profiles = SCENARIO.map((p) => p.profile);
    expect(profiles).toContain('empty');
    expect(profiles).toContain('complete');
    expect(profiles).toContain('partial');
  });

  it('includes a plant that is comfortably overdue and one that is fully up to date', () => {
    expect(SCENARIO.some((p) => Object.values(p.lastDone).some((d) => d >= 60))).toBe(true);
    expect(SCENARIO.some((p) => Object.values(p.lastDone).every((d) => d <= 10))).toBe(true);
  });

  it('includes a photographed history that declines, for the doctor to diagnose', () => {
    const declining = SCENARIO.find((p) => p.progress.length >= 3);
    expect(declining).toBeDefined();
    expect(declining!.progress.at(-1)!.health).toBe('POOR');
    expect(declining!.progress.some((e) => e.photos > 0)).toBe(true);
  });

  it('uses only tags from the shared vocabulary', () => {
    for (const plant of SCENARIO) {
      for (const entry of plant.progress) {
        for (const tag of entry.tags ?? []) {
          expect(PROGRESS_TAG_KEYS).toContain(tag);
        }
      }
    }
  });

  // Relative offsets are what stop the fixture rotting. A literal date would still load a year from now,
  // it would just no longer mean "overdue" — the worst kind of broken test data.
  it('expresses every date as an offset, never a literal', () => {
    for (const plant of SCENARIO) {
      expect(Number.isInteger(plant.acquiredDaysAgo)).toBe(true);
      for (const [, d] of Object.entries(plant.lastDone)) expect(Number.isInteger(d)).toBe(true);
      for (const e of plant.progress) expect(Number.isInteger(e.daysAgo)).toBe(true);
    }
  });

  // The care engine anchors a task with NO record to the ACQUISITION date, so an omitted task silently
  // reads as hundreds of days overdue. That is how the "healthy baseline" first shipped reporting a
  // 398-day-overdue task while claiming nothing was due. The baseline must anchor every task any other
  // plant anchors, or its briefing is a lie.
  it('anchors every scheduled task on the healthy baseline', () => {
    const healthy = SCENARIO.find((p) => p.key === 'healthy')!;
    const everyTaskUsed = new Set(SCENARIO.flatMap((p) => Object.keys(p.lastDone)));
    for (const task of everyTaskUsed) {
      expect(Object.keys(healthy.lastDone)).toContain(task);
    }
  });

  it('gives the healthy baseline a progress history, so its PROGRESS task is anchored too', () => {
    const healthy = SCENARIO.find((p) => p.key === 'healthy')!;
    expect(healthy.progress.length).toBeGreaterThan(0);
  });

  it('never dates a progress entry before the plant was acquired', () => {
    for (const plant of SCENARIO) {
      for (const e of plant.progress) {
        expect(e.daysAgo).toBeLessThanOrEqual(plant.acquiredDaysAgo);
      }
    }
  });
});
