import 'reflect-metadata'; // class-validator/transformer decorators on progress.dto.ts read metadata at runtime (main.ts does this in prod)
import { describe, expect, it } from 'vitest';
import { Task, ProgressHealth } from '@prisma/client';
import { FREQUENCY_BEARING_TASKS, PROGRESS_HEALTH_VALUES, MAX_SIZE_CM as SHARED_MAX } from '@retaxmaster/my-plants-species-schema';
import { MAX_SIZE_CM } from '../../progress/progress.dto.js';

describe('shared care-operations vocab parity with Prisma/DTO', () => {
  it('frequency-bearing tasks == Prisma Task minus PROGRESS', () => {
    expect([...FREQUENCY_BEARING_TASKS].sort()).toEqual(Object.values(Task).filter((t) => t !== Task.PROGRESS).sort());
  });
  it('progress health == Prisma ProgressHealth', () => {
    expect([...PROGRESS_HEALTH_VALUES].sort()).toEqual(Object.values(ProgressHealth).sort());
  });
  it('MAX_SIZE_CM matches the DTO', () => {
    expect(SHARED_MAX).toBe(MAX_SIZE_CM);
  });
});
