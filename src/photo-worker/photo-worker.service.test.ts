import { describe, expect, it } from 'vitest';
import { makeHarness } from './__fixtures__/photo-worker-harness.js';

describe('PhotoWorkerService — claim + happy path', () => {
  it('PENDING → PROCESSING (unique-per-claim key) → READY, deletes the inbox file', async () => {
    const h = makeHarness();
    const { id, plantId, inboxPath } = h.seedPending({ originalName: 'IMG_1.JPG' });
    await h.worker.drainOnce();
    const row = h.db.get(id)!;
    expect(row.status).toBe('READY');
    expect(row.imageUrl).toBeTruthy();
    expect(row.inboxPath).toBeNull();
    expect(row.claimToken).toBeNull();
    // upload() got the unique-per-claim key and R2 holds exactly that one object.
    const key = `plants/${plantId}/progress/${id}-${h.lastClaimToken}.webp`;
    expect(h.r2.has(key)).toBe(true);
    expect(h.r2.size).toBe(1);
    expect(h.inbox.has(inboxPath)).toBe(false); // staged bytes deleted after commit
  });

  it('compensates (deletes ONLY its own key) when the guarded commit changes 0 rows', async () => {
    const h = makeHarness();
    const { id, plantId } = h.seedPending();
    // Arm the commit to lose the row: between upload and the guarded READY commit, flip the row's token so the
    // guarded READY UPDATE matches 0 rows (a stand-in for a concurrent re-claim/RECOVERING take-over).
    h.onBeforeCommit(() => h.db.mutate(id, { claimToken: 'someone-else' }));
    await h.worker.drainOnce();
    const ownKey = `plants/${plantId}/progress/${id}-${h.lastClaimToken}.webp`;
    expect(h.r2.has(ownKey)).toBe(false); // our own object was compensated
    expect(h.db.get(id)!.claimToken).toBe('someone-else'); // this worker did NOT mutate the row's state
  });

  it('runs at most ONE of its own decodes at a time (concurrency guard)', async () => {
    const h = makeHarness();
    h.seedPending(); h.seedPending();
    let concurrent = 0, maxConcurrent = 0;
    h.r2.onUpload(async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await h.tick(); concurrent--; });
    await Promise.all([h.worker.enqueueTickAsync(), h.worker.enqueueTickAsync()]); // two overlapping nudges
    expect(maxConcurrent).toBe(1); // the second drain returned immediately; never two decodes at once
  });
});
