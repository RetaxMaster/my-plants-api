import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { PhotoInboxService } from '../storage/photo-inbox.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
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
export class PhotoWorkerService implements OnModuleInit {
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
      // Task 9 inserts: await this.recoverStaleClaims(); await this.sweepInboxTtlAndOrphans();
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
        SET status = 'PROCESSING', claim_token = ${token}, claimed_at = NOW()
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

  private async process(claim: Claim): Promise<void> {
    // inbox_lost handling + timeout + failure classification are added in Task 8. Happy path only here:
    const key = this.keyFor(claim.plantId, claim.id, claim.claimToken);
    let stored: { imageUrl: string; imageObjectKey: string };
    try {
      const buffer = await this.readInbox(claim.inboxPath); // Task 8 adds the missing/unreadable → inbox_lost path
      stored = await this.images.upload({ buffer, key });
    } catch (err) {
      await this.recordFailure(claim, key, err); // Task 8
      return;
    }
    // Commit guarded by id + token + status='PROCESSING' (§4.2 step 3). If 0 rows, recovery/re-claim moved
    // the row → the object we PUT is unreferenced → delete OUR OWN key (never a winner's) as compensation.
    const affected = await this.commitReady(claim, stored);
    if (affected === 1) {
      await this.inbox.delete(claim.inboxPath); // best-effort, after commit
    } else {
      await this.images.delete(stored.imageObjectKey); // compensate our own key only
    }
  }

  // The guarded READY commit (extracted so both process() and the tests reference it by name).
  private async commitReady(claim: Claim, stored: { imageUrl: string; imageObjectKey: string }): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE plant_progress_photos
      SET status = 'READY', image_url = ${stored.imageUrl}, image_object_key = ${stored.imageObjectKey},
          inbox_path = NULL, claim_token = NULL
      WHERE id = ${claim.id} AND claim_token = ${claim.claimToken} AND status = 'PROCESSING'`;
  }

  // Read the staged bytes THROUGH the inbox service (never raw fs — keeps it injectable/fakeable). Task 8
  // maps a missing/unreadable file to the inbox_lost terminal state.
  private async readInbox(inboxPath: string | null): Promise<Buffer> {
    if (!inboxPath) throw new InboxLostError('no inbox path');
    return this.inbox.read(inboxPath);
  }

  // Placeholder — fully implemented in Task 8.
  private async recordFailure(_claim: Claim, _key: string, err: unknown): Promise<void> { throw err; }
}
