import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PhotoInboxService } from '../storage/photo-inbox.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { ImageUploadError } from '../storage/image-upload.errors.js';
import { PHOTO_FAILURE_CODES } from '@retaxmaster/my-plants-species-schema/photo-contract-constants';

// Tuned constants (spec §2 ledger / §4). A command never invents one of these — they are the ledger's values.
const CLAIM_STALE_SECONDS = 120; // §4.5 — MUST be > PHOTO_PROCESS_TIMEOUT_MS
const PHOTO_PROCESS_TIMEOUT_MS = 60_000; // §4.3 — per-photo hard deadline, really cancels decode+PUT
const MAX_TRANSIENT_ATTEMPTS = 3; // §4.4 — 3 failed attempts total (two waits: 30 s, 5 min)
const BACKOFF_SECONDS = [30, 300]; // §4.4 — after attempt 1, then attempt 2
const INBOX_RETRY_TTL_DAYS = 7; // §4.4 — transient-FAILED inbox bytes kept this long

// Permanent = every PERSISTED failure code EXCEPT the single transient-terminal one (`upload_failed`).
// DERIVED from the shared union (BLOCKER 7) so a new shared code can never silently miss classification;
// the API↔shared parity test (Task 11b) pins this membership. `image_processing_timeout` is an INTERNAL,
// never-persisted signal (§4.3) and is intentionally absent from the shared union → it stays transient.
export const PERMANENT_CODES = new Set<string>(PHOTO_FAILURE_CODES.filter((c) => c !== 'upload_failed'));

// The two failure codes the worker assigns DIRECTLY (they are not thrown as ImageUploadError / ImageErrorCode):
// `inbox_lost` (staged bytes missing) and `upload_failed` (exhausted transient). EXPORTED so the parity test
// (Task 11b) can reconstruct "the codes the API actually persists" from real code, not a copy of the shared
// array. Use these constants for the assignments below — never re-type the literals.
export const WORKER_ONLY_FAILURE_CODES = ['inbox_lost', 'upload_failed'] as const;
const [INBOX_LOST_CODE, UPLOAD_FAILED_CODE] = WORKER_ONLY_FAILURE_CODES;

interface Claim {
  id: string;
  plantId: string;
  inboxPath: string | null;
  claimToken: string;
  attempts: number;
}

// A worker-internal failure code that is NOT an ImageUploadError (spec §5.2): the staged bytes are gone.
class InboxLostError extends Error {}

@Injectable()
export class PhotoWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PhotoWorkerService.name);
  private draining = false; // in-process concurrency guard: one drain at a time (spec §4.1/§4.3)
  private stopping = false; // set on shutdown so we stop claiming new work (spec §4.5)
  private activeProcessing: Promise<void> | null = null; // in-flight process() promise (awaited on shutdown, §4.5)

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: PhotoInboxService,
    private readonly images: ImageUploadService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Recovery on boot (§4.5) is added in Task 9. Kick a drain so anything left PENDING is picked up.
    void this.drain();
  }

  // Immediate nudge after a POST/retry commits, so the common case processes within a moment (§4.1).
  enqueueTick(): void { void this.drain(); }

  @Cron(CronExpression.EVERY_30_SECONDS) // safety-net sweep (§4.1)
  async sweep(): Promise<void> { await this.drain(); }

  // One drain: process eligible photos ONE AT A TIME until none remain. A tick that starts while a previous
  // drain is running returns immediately (§4.1/§4.3). Recovery + orphan/TTL sweeps hook in here (Task 9).
  private async drain(): Promise<void> {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      await this.recoverStaleClaims();
      await this.sweepInboxTtlAndOrphans();
      for (;;) {
        if (this.stopping) break;
        const claimed = await this.claimNext();
        if (!claimed) break;
        // Track the in-flight promise so onModuleDestroy() can AWAIT its settlement on shutdown (§4.5).
        this.activeProcessing = this.process(claimed);
        try { await this.activeProcessing; } finally { this.activeProcessing = null; }
      }
    } catch (err) {
      this.logger.error(`drain failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  // Atomically claim ONE eligible PENDING photo with a fresh token. Returns the claimed row's fields or null.
  private async claimNext(): Promise<Claim | null> {
    const token = randomUUID();
    // Pick a candidate id first (eligibility: PENDING and due), then claim it by a guarded UPDATE. If the
    // UPDATE changes 0 rows another worker/tick took it — try the next candidate. NOW() is the DB clock.
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM plant_progress_photos p
      WHERE p.status = 'PENDING' AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= NOW())
      ORDER BY p.created_at ASC LIMIT 10`;
    for (const c of candidates) {
      const affected = await this.prisma.$executeRaw`
        UPDATE plant_progress_photos
        SET status = 'PROCESSING', claim_token = ${token}, claimed_at = NOW(), updated_at = NOW(3)
        WHERE id = ${c.id} AND status = 'PENDING'
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`;
      if (affected === 1) {
        const row = await this.prisma.plantProgressPhoto.findUniqueOrThrow({
          where: { id: c.id },
          include: { entry: { select: { plantId: true } } },
        });
        return { id: row.id, plantId: row.entry.plantId, inboxPath: row.inboxPath, claimToken: token, attempts: row.attempts };
      }
    }
    return null;
  }

  // The R2 key is UNIQUE PER CLAIM (§4.2 step 2): two overlapping workers write two DIFFERENT objects, so a
  // losing/crashed claim's compensation can never touch a winner's live object.
  private keyFor(plantId: string, photoId: string, token: string): string {
    return `plants/${plantId}/progress/${photoId}-${token}.webp`;
  }

  // Drive the upload with an AbortController + timer (spec §4.3): the claim is never cleared/rescheduled until
  // the underlying op has actually SETTLED (the timeout cancels the decode/PUT, it does not race ahead of it).
  private async process(claim: Claim): Promise<void> {
    const key = this.keyFor(claim.plantId, claim.id, claim.claimToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_PROCESS_TIMEOUT_MS);
    let stored: { imageUrl: string; imageObjectKey: string } | null = null;
    let failure: unknown = null;
    try {
      const buffer = await this.readInbox(claim.inboxPath);
      stored = await this.images.upload({ buffer, key, signal: controller.signal });
    } catch (err) {
      failure = err; // includes an abort → treated as transient below
    } finally {
      clearTimeout(timer);
    }
    if (stored) {
      const affected = await this.commitReady(claim, stored);
      if (affected === 1) {
        await this.inbox.delete(claim.inboxPath); // best-effort, after commit
      } else {
        // Lost the claim (row re-claimed / taken into RECOVERING) → our own unique-per-claim object is
        // unreferenced. Genuine best-effort orphan cleanup: NOTHING gates on its success (no token release,
        // no state change here), so delete() is correct. The token-release-gating compensations —
        // recordFailure's compensateKey and §4.5 recovery — are the ones that MUST use confirmDelete (BLOCKER 4).
        await this.images.delete(stored.imageObjectKey);
      }
      return;
    }
    await this.recordFailure(claim, key, failure);
  }

  // The guarded READY commit (extracted so both process() and the tests reference it by name).
  private async commitReady(claim: Claim, stored: { imageUrl: string; imageObjectKey: string }): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE plant_progress_photos
      SET status = 'READY', image_url = ${stored.imageUrl}, image_object_key = ${stored.imageObjectKey},
          inbox_path = NULL, claim_token = NULL, updated_at = NOW(3)
      WHERE id = ${claim.id} AND claim_token = ${claim.claimToken} AND status = 'PROCESSING'`;
  }

  // Read the staged bytes THROUGH the inbox service (never raw fs — keeps it injectable/fakeable). A missing
  // or unreadable file becomes the permanent inbox_lost terminal state (spec §3.2).
  private async readInbox(inboxPath: string | null): Promise<Buffer> {
    if (!inboxPath) throw new InboxLostError('no inbox path'); // missing staged bytes → permanent inbox_lost
    try {
      return await this.inbox.read(inboxPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') throw new InboxLostError('staged bytes missing or unreadable');
      throw err;
    }
  }

  // permanent = the image/bytes themselves are the problem (retry re-runs the identical failure). Everything
  // else (R2/network/abort/unexpected throw) is transient. `image_processing_timeout` is deliberately NOT in
  // PERMANENT_CODES, so a cancelled/timed-out pipeline classifies transient (BLOCKER 6a).
  private isPermanent(err: unknown): { code: string } | null {
    if (err instanceof InboxLostError) return { code: INBOX_LOST_CODE }; // §3.2 missing/unreadable bytes
    if (err instanceof ImageUploadError && PERMANENT_CODES.has(err.code)) return { code: err.code };
    return null;
  }

  private async recordFailure(claim: Claim, key: string, err: unknown): Promise<void> {
    const perm = this.isPermanent(err);
    if (perm) {
      // Permanent: give up immediately. Delete the (useless) inbox bytes. Guarded write. For a permanent image
      // fault we never PUT an object (upload threw before the PUT), so nothing to compensate in R2.
      const affected = await this.prisma.$executeRaw`
        UPDATE plant_progress_photos
        SET status='FAILED', failure_kind='permanent', failure_code=${perm.code},
            inbox_path=NULL, claim_token=NULL, updated_at=NOW(3)
        WHERE id=${claim.id} AND claim_token=${claim.claimToken} AND status='PROCESSING'`;
      if (affected === 1) await this.inbox.delete(claim.inboxPath);
      return;
    }
    // Transient: compensate our OWN key BEFORE releasing the token (a failed PUT may have created the object).
    const compensated = await this.compensateKey(key); // bounded retries → true on success or confirmed 404
    if (!compensated) {
      // Cannot confirm the object is gone → LEAVE the row PROCESSING with its token intact so §4.5 recovery
      // (which reconstructs the key from the retained token) becomes the durable backstop. Do NOT reschedule.
      this.logger.warn(`transient compensation unconfirmed for ${claim.id}; leaving PROCESSING for recovery`);
      return;
    }
    const nextAttempts = claim.attempts + 1;
    if (nextAttempts >= MAX_TRANSIENT_ATTEMPTS) {
      await this.prisma.$executeRaw`
        UPDATE plant_progress_photos
        SET status='FAILED', failure_kind='transient', failure_code=${UPLOAD_FAILED_CODE},
            attempts=${nextAttempts}, claim_token=NULL, updated_at=NOW(3)
        WHERE id=${claim.id} AND claim_token=${claim.claimToken} AND status='PROCESSING'`;
      return; // inbox bytes KEPT for a manual retry; the TTL (Task 9) now measures from THIS updated_at (last failure)
    }
    // Not the final attempt: reschedule with real time-based backoff on the DB clock (never toISOString).
    const backoff = BACKOFF_SECONDS[nextAttempts - 1] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    await this.prisma.$executeRaw`
      UPDATE plant_progress_photos
      SET status='PENDING', attempts=${nextAttempts}, claim_token=NULL, updated_at=NOW(3),
          next_attempt_at = DATE_ADD(NOW(), INTERVAL ${Prisma.raw(String(backoff))} SECOND)
      WHERE id=${claim.id} AND claim_token=${claim.claimToken} AND status='PROCESSING'`;
  }

  // Durable delete of our own key with bounded retries; true ONLY on a confirmed R2 delete OR a confirmed 404
  // (already gone). Uses confirmDelete() — which PROPAGATES an unconfirmed outcome — NOT delete() (which
  // swallows every error and would always report success even while the object still lives, breaking the
  // RECOVERING contract, BLOCKER 4). A false return means "not confirmed gone" → the caller leaves the row
  // claimed for §4.5 recovery rather than releasing it.
  private async compensateKey(key: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      try { await this.images.confirmDelete(key); return true; } // resolves only on confirmed delete / 404
      catch { /* unconfirmed (R2 down/5xx) — retry */ }
    }
    return false;
  }

  // Graceful shutdown (§4.5 / BLOCKER 6b): stop claiming NEW photos, then AWAIT the in-flight one so it
  // finishes (or hits its own per-photo deadline) instead of being abandoned mid-upload. Bounded: the active
  // process() already self-limits to PHOTO_PROCESS_TIMEOUT_MS; the outer race is a hard ceiling so a wedged
  // promise can never hang pm2's reload forever. Setting stopping=true is NOT enough on its own.
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const active = this.activeProcessing;
    if (!active) return;
    await Promise.race([
      active.catch(() => undefined), // its own failure handling already ran; we only wait for settlement
      new Promise<void>((resolve) => setTimeout(resolve, PHOTO_PROCESS_TIMEOUT_MS + 5_000)),
    ]);
  }

  // Recover STALE claims — never a blanket PROCESSING→PENDING reset (a reload can briefly overlap two API
  // instances; a blanket reset would double-upload the in-flight photo). Go THROUGH RECOVERING, retaining the
  // token, so the stale key stays reconstructible until its delete is confirmed (§4.5). Also sweep RECOVERING
  // rows unconditionally (they are already known-dead).
  private async recoverStaleClaims(): Promise<void> {
    const stale = await this.prisma.$queryRaw<{ id: string; claim_token: string; plant_id: string }[]>`
      SELECT ph.id, ph.claim_token, e.plant_id
      FROM plant_progress_photos ph JOIN plant_progress_entries e ON e.id = ph.entry_id
      WHERE ph.claim_token IS NOT NULL AND (
        (ph.status = 'PROCESSING' AND ph.claimed_at < DATE_SUB(NOW(), INTERVAL ${Prisma.raw(String(CLAIM_STALE_SECONDS))} SECOND))
        OR ph.status = 'RECOVERING')`;
    for (const row of stale) {
      const oldToken = row.claim_token;
      // 1. Take over into RECOVERING, RETAINING the token. 0 rows = the old worker already finished → leave it.
      const took = await this.prisma.$executeRaw`
        UPDATE plant_progress_photos SET status='RECOVERING', claimed_at=NOW(), updated_at=NOW(3)
        WHERE id=${row.id} AND claim_token=${oldToken}
          AND (status='PROCESSING' AND claimed_at < DATE_SUB(NOW(), INTERVAL ${Prisma.raw(String(CLAIM_STALE_SECONDS))} SECOND)
               OR status='RECOVERING')`;
      if (took !== 1) continue;
      // 2. Confirm-delete the stale key, THEN release. Only on confirmed success/404 do we reset to PENDING.
      const key = this.keyFor(row.plant_id, row.id, oldToken);
      const gone = await this.compensateKey(key);
      if (!gone) continue; // R2 still down → leave RECOVERING (token intact); a later sweep retries. DURABLE.
      await this.prisma.$executeRaw`
        UPDATE plant_progress_photos
        SET status='PENDING', claim_token=NULL, claimed_at=NULL, next_attempt_at=NULL, updated_at=NOW(3)
        WHERE id=${row.id} AND status='RECOVERING' AND claim_token=${oldToken}`;
    }
  }

  // Inbox TTL sweep (§4.4): a FAILED photo whose bytes were never retried keeps its file forever. Delete the
  // file for a FAILED row older than INBOX_RETRY_TTL_DAYS and NULL its inboxPath so `retryable` becomes false.
  // Then the orphan-file sweep (§3.2) removes any .bin/.tmp with no matching row.
  private async sweepInboxTtlAndOrphans(): Promise<void> {
    const expired = await this.prisma.$queryRaw<{ id: string; inbox_path: string }[]>`
      SELECT id, inbox_path FROM plant_progress_photos
      WHERE status='FAILED' AND inbox_path IS NOT NULL
        AND updated_at < DATE_SUB(NOW(), INTERVAL ${Prisma.raw(String(INBOX_RETRY_TTL_DAYS))} DAY)`;
    for (const row of expired) {
      // ATOMICALLY CLAIM the expiry BEFORE touching the file (BLOCKER 5): null inbox_path with a guarded
      // UPDATE that still requires status='FAILED', the SAME inbox_path, and still-past-TTL. This serialises
      // the sweep against the retry endpoint (CRUD Task 3), which locks the row FOR UPDATE, re-checks the
      // file, and flips FAILED→PENDING. If a retry adopted the bytes first, this UPDATE matches 0 rows and we
      // do NOT delete the file. ONLY the winner (claimed === 1) deletes — so a PENDING row can never be left
      // pointing at bytes we just erased.
      const claimed = await this.prisma.$executeRaw`
        UPDATE plant_progress_photos SET inbox_path=NULL
        WHERE id=${row.id} AND status='FAILED' AND inbox_path=${row.inbox_path}
          AND updated_at < DATE_SUB(NOW(), INTERVAL ${Prisma.raw(String(INBOX_RETRY_TTL_DAYS))} DAY)`;
      if (claimed === 1) await this.inbox.delete(row.inbox_path);
    }
    // Orphan sweep: pass the set of inboxPaths still referenced by a row so live files are never touched.
    const known = await this.prisma.plantProgressPhoto.findMany({
      where: { inboxPath: { not: null } }, select: { inboxPath: true },
    });
    await this.inbox.sweepOrphans({ knownPaths: new Set(known.map((k) => k.inboxPath!).filter((p): p is string => p !== null)) });
  }
}
