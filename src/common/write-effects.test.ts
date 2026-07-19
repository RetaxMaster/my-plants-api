import { describe, it, expect, vi } from 'vitest';
import { emptyEffects, mergeEffects, runEffects } from './write-effects.js';

describe('write effects', () => {
  it('de-duplicates a care-plan recompute requested by several operations', async () => {
    const merged = mergeEffects([
      { ...emptyEffects(), recomputePlantIds: ['p1'] },
      { ...emptyEffects(), recomputePlantIds: ['p1'] },
      { ...emptyEffects(), recomputePlantIds: ['p2'] },
    ]);
    const recompute = vi.fn(async (_plantId: string) => {});
    await runEffects(merged, {
      recomputePlant: recompute,
      deleteObject: async () => {},
      deleteInboxPaths: async () => {},
      enqueuePhotoTick: () => {},
      logger: { warn: vi.fn() },
    });
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(recompute.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2']);
  });

  it('does not throw when a post-commit effect fails, and logs it', async () => {
    const warn = vi.fn();
    const effects = { ...emptyEffects(), recomputePlantIds: ['p1'], deleteObjectKeys: ['k1'] };
    await expect(
      runEffects(effects, {
        recomputePlant: async () => {
          throw new Error('boom');
        },
        deleteObject: async () => {},
        deleteInboxPaths: async () => {},
        enqueuePhotoTick: () => {},
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('logs the object keys whose deletion outcome is unconfirmed', async () => {
    const warn = vi.fn();
    await runEffects(
      { ...emptyEffects(), deleteObjectKeys: ['k1', 'k2'] },
      {
        recomputePlant: async () => {},
        deleteObject: async () => {},
        deleteInboxPaths: async () => {},
        enqueuePhotoTick: () => {},
        logger: { warn },
      },
    );
    expect(warn.mock.calls.flat().join(' ')).toContain('k1');
  });
});
