import { describe, expect, it } from 'vitest';
import { Task, ProgressHealth } from '@prisma/client';

// Guards that the migration + client regeneration actually landed the new enum surface the later
// phases compile against. Pure enum reads — no DB, env-hermetic.
describe('care-history prisma client surface', () => {
  it('exposes PROGRESS on the Task enum', () => {
    expect(Task.PROGRESS).toBe('PROGRESS');
  });

  it('exposes the ProgressHealth enum with all four grades', () => {
    expect(ProgressHealth.SICK).toBe('SICK');
    expect(ProgressHealth.POOR).toBe('POOR');
    expect(ProgressHealth.GOOD).toBe('GOOD');
    expect(ProgressHealth.EXCELLENT).toBe('EXCELLENT');
  });
});
