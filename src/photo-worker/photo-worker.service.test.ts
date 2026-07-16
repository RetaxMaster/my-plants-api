import { describe, expect, it, vi } from 'vitest';
import { makeHarness } from './__fixtures__/photo-worker-harness.js';
import { ImageUploadError } from '../storage/image-upload.errors.js';

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

describe('PhotoWorkerService — failures', () => {
  it('permanent image fault → FAILED/permanent/image_too_large, inbox deleted, no retry, no object', async () => {
    const h = makeHarness();
    const { id, inboxPath } = h.seedPending();
    h.r2.armUploadError(new ImageUploadError('image_too_large', 'too big'));
    await h.worker.drainOnce();
    const row = h.db.get(id)!;
    expect(row.status).toBe('FAILED');
    expect(row.failureKind).toBe('permanent');
    expect(row.failureCode).toBe('image_too_large');
    expect(row.nextAttemptAt).toBeNull(); // permanent → never rescheduled
    expect(row.claimToken).toBeNull();
    expect(row.inboxPath).toBeNull();
    expect(h.inbox.has(inboxPath)).toBe(false); // useless bytes deleted
    expect(h.r2.size).toBe(0); // no object was ever PUT
  });

  it('missing inbox bytes → FAILED/permanent/inbox_lost (a present-but-corrupt file is image_decode_failed instead)', async () => {
    const h = makeHarness();
    const { id, inboxPath } = h.seedPending();
    h.inbox.remove(inboxPath); // readInbox → ENOENT → InboxLostError
    await h.worker.drainOnce();
    const row = h.db.get(id)!;
    expect(row.status).toBe('FAILED');
    expect(row.failureKind).toBe('permanent');
    expect(row.failureCode).toBe('inbox_lost');
    // Contrast: a PRESENT file that upload() rejects as image_decode_failed → permanent/image_decode_failed.
    const h2 = makeHarness();
    const p2 = h2.seedPending();
    h2.r2.armUploadError(new ImageUploadError('image_decode_failed', 'corrupt'));
    await h2.worker.drainOnce();
    expect(h2.db.get(p2.id)!.failureCode).toBe('image_decode_failed');
  });

  it('transient failure (not final) → confirmDelete(ownKey) FIRST, then PENDING with attempts++ and backoff', async () => {
    const h = makeHarness();
    const { id, plantId } = h.seedPending({ attempts: 0 });
    h.r2.armUploadError(new Error('ECONNRESET')); // network → transient
    await h.worker.drainOnce();
    const ownKey = `plants/${plantId}/progress/${id}-${h.lastClaimToken}.webp`;
    expect(h.r2.confirmDeleteCalls[0]).toBe(ownKey); // compensated via confirmDelete, not delete()
    // ordering: the confirmDelete happened BEFORE the row was rescheduled to PENDING
    expect(h.events.indexOf(`confirmDelete:${ownKey}`)).toBeLessThan(h.events.indexOf(`update:${id}:PENDING`));
    const row = h.db.get(id)!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.claimToken).toBeNull();
    expect(row.nextAttemptAt).not.toBeNull(); // 30 s backoff (attempt 1)
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(h.clock.now());
  });

  it('exhausted transient (3rd failure) → FAILED/transient/upload_failed, inbox bytes KEPT for manual retry', async () => {
    const h = makeHarness();
    const { id, inboxPath } = h.seedPending({ attempts: 2 }); // this is the 3rd attempt
    h.r2.armUploadError(new Error('ETIMEDOUT'));
    await h.worker.drainOnce();
    const row = h.db.get(id)!;
    expect(row.status).toBe('FAILED');
    expect(row.failureKind).toBe('transient');
    expect(row.failureCode).toBe('upload_failed');
    expect(row.attempts).toBe(3);
    expect(row.inboxPath).toBe(inboxPath); // KEPT — a retry can reuse it (until the TTL sweep)
    expect(h.inbox.has(inboxPath)).toBe(true);
  });

  it('unconfirmed compensation (R2 down) leaves the row PROCESSING with its token — for §4.5 recovery', async () => {
    const h = makeHarness();
    const { id } = h.seedPending({ attempts: 0 });
    h.r2.armUploadError(new Error('ECONNRESET'));
    h.r2.failConfirmDeleteFor(3); // all 3 compensateKey attempts fail → cannot confirm the object gone
    await h.worker.drainOnce();
    const row = h.db.get(id)!;
    expect(row.status).toBe('PROCESSING'); // NOT rescheduled
    expect(row.claimToken).not.toBeNull(); // token retained → key reconstructible for recovery
    expect(row.attempts).toBe(0); // no reschedule bookkeeping happened
  });

  it('a bounced row is NOT re-claimed in the same drain (nextAttemptAt in the future is ineligible)', async () => {
    const h = makeHarness();
    const { id } = h.seedPending({ attempts: 0 });
    h.r2.armUploadError(new Error('ECONNRESET')); // first attempt fails → PENDING with +30 s backoff
    await h.worker.drainOnce(); // drain: fail → reschedule → loop tries to re-claim
    expect(h.db.get(id)!.attempts).toBe(1); // only ONE failed attempt this drain (not re-claimed early)
  });

  it('per-photo timeout aborts a hung upload and records a TRANSIENT failure only AFTER the op settles', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { id } = h.seedPending({ attempts: 0 });
    h.r2.armUploadHang(); // upload() resolves/rejects only when its AbortSignal fires
    const drain = h.worker.drainOnce();
    await vi.advanceTimersByTimeAsync(60_000); // PHOTO_PROCESS_TIMEOUT_MS → abort fires, upload rejects
    await drain;
    const row = h.db.get(id)!;
    expect(row.status).toBe('PENDING'); // abort classified transient → rescheduled
    expect(row.failureCode).not.toBe('image_decode_failed'); // NOT misclassified permanent (BLOCKER 6a)
    expect(h.r2.settledBeforeRecord).toBe(true); // failure recorded only after the upload promise settled
    vi.useRealTimers();
  });

  it('a lost claim (row taken to RECOVERING with same token) after a successful upload → own-key best-effort delete, no state change', async () => {
    const h = makeHarness();
    const { id, plantId } = h.seedPending({ attempts: 0 });
    // upload() SUCCEEDS, but before the guarded READY commit the row is moved to RECOVERING, so the
    // id+token+status='PROCESSING' guard matches 0 rows. The now-unreferenced own object is a best-effort
    // orphan cleanup via delete() (NOT confirmDelete — nothing gates on it, B4 annotation).
    h.onBeforeCommit(() => h.db.mutate(id, { status: 'RECOVERING' }));
    await h.worker.drainOnce();
    const ownKey = `plants/${plantId}/progress/${id}-${h.lastClaimToken}.webp`;
    expect(h.db.get(id)!.status).toBe('RECOVERING'); // this worker mutated nothing
    expect(h.r2.deleteCalls).toContain(ownKey); // best-effort delete of our own key
    expect(h.r2.has(ownKey)).toBe(false);
  });
});

describe('PhotoWorkerService — recovery & sweeps (spec §4.5 tests a/b/c)', () => {
  it('(a) two workers, one PENDING photo → exactly one READY row + one referenced object', async () => {
    const h = makeHarness();
    const { id } = h.seedPending();
    const workerB = h.spawnSecondWorker(); // second PhotoWorkerService over the SAME db/inbox/r2
    await Promise.all([h.worker.drainOnce(), workerB.drainOnce()]);
    expect(h.db.get(id)!.status).toBe('READY');
    expect([...h.db.values()].filter((r) => r.status === 'READY')).toHaveLength(1);
    expect(h.r2.size).toBe(1);
    expect(h.r2.has(h.db.get(id)!.imageObjectKey!)).toBe(true); // the one object is the one READY references
  });

  it('(b) stale PROCESSING claim + a written object → RECOVERING (token kept) → confirm-delete stale key → PENDING → one READY + one object', async () => {
    const h = makeHarness();
    const oldToken = 'dead-worker-token';
    const { id, plantId } = h.seedProcessing({ claimToken: oldToken, claimedAtAgeSeconds: 300 }); // > CLAIM_STALE_SECONDS
    const staleKey = `plants/${plantId}/progress/${id}-${oldToken}.webp`;
    h.r2.add(staleKey); // the dead worker had already PUT its object
    await h.worker.drainOnce(); // recovery + reprocess in one drain
    expect(h.r2.has(staleKey)).toBe(false); // stale key confirm-deleted before release
    expect(h.db.get(id)!.status).toBe('READY');
    expect(h.r2.size).toBe(1); // exactly one object — the freshly reprocessed one
    expect(h.r2.has(h.db.get(id)!.imageObjectKey!)).toBe(true);
  });

  it('(c) R2 refuses the delete for the WHOLE first sweep → stays RECOVERING; a 2nd sweep with R2 back completes recovery', async () => {
    const h = makeHarness();
    const oldToken = 'dead-worker-token';
    const { id, plantId } = h.seedProcessing({ claimToken: oldToken, claimedAtAgeSeconds: 300 });
    const staleKey = `plants/${plantId}/progress/${id}-${oldToken}.webp`;
    h.r2.add(staleKey);
    // Fail ALL 3 attempts of the first sweep (NEW BLOCKER 1) so the row provably STAYS RECOVERING and only a
    // SECOND sweep (R2 restored) completes recovery.
    h.r2.failConfirmDeleteFor(3);
    // --- Sweep 1: R2 down for all 3 attempts ---
    await h.worker.recoverOnce();
    expect(h.db.get(id)!.status).toBe('RECOVERING'); // did NOT advance to PENDING
    expect(h.db.get(id)!.claimToken).toBe(oldToken); // token retained → key still reconstructible
    expect(h.r2.has(staleKey)).toBe(true); // object still present — never released over it
    // --- Sweep 2: R2 restored (the failFor budget is spent) ---
    await h.worker.recoverOnce();
    expect(h.r2.has(staleKey)).toBe(false); // stale key now confirm-deleted
    expect(h.db.get(id)!.status).toBe('PENDING'); // recovery released it to re-process
    expect(h.db.get(id)!.claimToken).toBeNull();
    // --- Reprocess ---
    await h.worker.drainOnce();
    expect(h.db.get(id)!.status).toBe('READY');
    expect(h.r2.size).toBe(1); // exactly one object — the freshly reprocessed one
  });

  it('a live claim younger than CLAIM_STALE_SECONDS is left alone', async () => {
    const h = makeHarness();
    const { id } = h.seedProcessing({ claimToken: 'live', claimedAtAgeSeconds: 30 }); // < 120
    await h.worker.recoverOnce();
    expect(h.db.get(id)!.status).toBe('PROCESSING'); // untouched
    expect(h.db.get(id)!.claimToken).toBe('live');
  });

  it('inbox TTL sweep atomically claims the expiry, deletes bytes of a FAILED photo older than INBOX_RETRY_TTL_DAYS, nulls inboxPath', async () => {
    const h = makeHarness();
    const { id, inboxPath } = h.seedFailedTransient({ updatedAtAgeDays: 8, inboxPresent: true }); // > 7-day TTL
    await h.worker.sweepOnce();
    expect(h.db.get(id)!.inboxPath).toBeNull();
    expect(h.inbox.has(inboxPath)).toBe(false);
  });

  it('TTL sweep does NOT delete bytes a concurrent retry adopted (guarded claim matches 0 rows — BLOCKER 5)', async () => {
    const h = makeHarness();
    const { id, inboxPath } = h.seedFailedTransient({ updatedAtAgeDays: 8, inboxPresent: true });
    // Simulate the retry winning the row first: it flips FAILED→PENDING (as CRUD Task 3's retry does under
    // FOR UPDATE) before the sweep's guarded UPDATE runs.
    h.db.mutate(id, { status: 'PENDING', failureKind: null, failureCode: null });
    await h.worker.sweepOnce();
    expect(h.inbox.has(inboxPath)).toBe(true); // bytes preserved for the adopted retry
    expect(h.db.get(id)!.inboxPath).toBe(inboxPath);
  });
});
