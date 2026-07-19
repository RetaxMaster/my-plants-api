/**
 * Post-commit side effects of a write core.
 *
 * A write core performs ONLY DB writes inside the caller's transaction. Recomputing a care plan and
 * deleting an object from storage cannot participate in that transaction, so a core *describes* them
 * here and the caller runs them after commit. Merging is what makes a care-plan recompute requested by
 * three operations of one proposal run exactly once.
 */
export type WriteEffects = {
  /** Plant ids whose care plan must be recomputed after commit. De-duplicated. */
  recomputePlantIds: string[];
  /** R2 object keys to delete. Best-effort: ImageUploadService.delete swallows its error. */
  deleteObjectKeys: string[];
  /** Photo-inbox paths to delete. Best-effort, same caveat. */
  deleteInboxPaths: string[];
  /** True when new photo rows were staged and the photo worker must be nudged. */
  enqueuePhotoTick: boolean;
};

export type EffectRunner = {
  recomputePlant: (plantId: string) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
  deleteInboxPaths: (paths: string[]) => Promise<void>;
  enqueuePhotoTick: () => void;
  logger: { warn: (message: string, ...rest: unknown[]) => void };
};

export function emptyEffects(): WriteEffects {
  return { recomputePlantIds: [], deleteObjectKeys: [], deleteInboxPaths: [], enqueuePhotoTick: false };
}

export function mergeEffects(all: WriteEffects[]): WriteEffects {
  return {
    recomputePlantIds: [...new Set(all.flatMap((e) => e.recomputePlantIds))],
    deleteObjectKeys: [...new Set(all.flatMap((e) => e.deleteObjectKeys))],
    deleteInboxPaths: [...new Set(all.flatMap((e) => e.deleteInboxPaths))],
    enqueuePhotoTick: all.some((e) => e.enqueuePhotoTick),
  };
}

/**
 * Runs post-commit effects. NEVER throws: the DB state is already correct and committed, and the care
 * plan is derived data (spec 5.7 item 5). A failed effect is a logged warning, not an un-applied write.
 */
export async function runEffects(effects: WriteEffects, runner: EffectRunner): Promise<void> {
  for (const plantId of effects.recomputePlantIds) {
    try {
      await runner.recomputePlant(plantId);
    } catch (err) {
      runner.logger.warn(`post-commit care-plan recompute failed for plant ${plantId}`, err);
    }
  }

  if (effects.deleteObjectKeys.length > 0) {
    // ImageUploadService.delete() swallows its error and returns void, so we cannot learn WHICH key
    // failed. Log the keys ATTEMPTED, whose outcome is unconfirmed.
    await Promise.all(effects.deleteObjectKeys.map((k) => runner.deleteObject(k)));
    runner.logger.warn(
      `object-storage deletion attempted with unconfirmed outcome for keys: ${effects.deleteObjectKeys.join(', ')}`,
    );
  }

  if (effects.deleteInboxPaths.length > 0) {
    try {
      await runner.deleteInboxPaths(effects.deleteInboxPaths);
    } catch (err) {
      runner.logger.warn(`photo-inbox cleanup failed for ${effects.deleteInboxPaths.join(', ')}`, err);
    }
  }

  if (effects.enqueuePhotoTick) runner.enqueuePhotoTick();
}
