import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { DoctorWriteProposal } from '@prisma/client';
import { KnowledgeChatService } from '../../knowledge-chat/knowledge-chat.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OwnerService } from '../../owner/owner.service.js';
import { ProposalSnapshotService } from './proposal-snapshot.service.js';
import { ProposalRenderService, type Locale, type ProposalView } from './proposal-render.service.js';
import { ProposalApplierService, SkipPermissionsRevokedError } from './proposal-applier.service.js';
import { SYSTEM_MESSAGE } from '../../knowledge-chat/system-message.js';
import { startOfTodayUtc, ymdFromUtcDate } from '../../common/time/local-date.js';
import {
  assertNoOverlappingWriteSets,
  assertSerializedBound,
  type CreateProposalBody,
  type ProposalOperation,
} from './proposal-operations.schema.js';

const PENDING_KEY = 'PENDING';
const TERMINAL_RUN = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * Doctor-token claims this service trusts. NOTHING here ever comes from the request body.
 *
 * `userId` — not `sub` — is the field name, because that is what `Actor` carries; there is no `sub`
 * claim on the actor to read.
 */
export type DoctorTokenClaims = {
  userId: string;
  plantId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
};

@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: ProposalSnapshotService,
    private readonly render: ProposalRenderService,
    private readonly applier: ProposalApplierService,
    private readonly owner: OwnerService,
    // Used ONLY by decline(), to start the queued system turn when the session is idle (spec 5.3).
    // No forwardRef is needed: the module graph is already one-way — `PlantDoctorModule` imports
    // `KnowledgeChatModule`, and this injection points the SAME direction. If you ever DO create a
    // cycle, fix the ownership; do not paper over it with forwardRef and do not duplicate run-admission
    // logic here.
    private readonly chat: KnowledgeChatService,
  ) {}

  // ---------- create (doctor token only) ----------

  async create(token: DoctorTokenClaims, body: CreateProposalBody): Promise<ProposalView> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id: token.sessionId } });
    if (
      !session ||
      session.kind !== 'DOCTOR' ||
      session.plantId !== token.plantId ||
      session.ownerId !== token.ownerId
    ) {
      throw new ForbiddenException('session does not match the token');
    }
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: token.runId } });
    if (!run || run.sessionId !== token.sessionId || TERMINAL_RUN.has(run.status)) {
      throw new ForbiddenException('run is terminal or does not belong to this session');
    }

    // Normalize + freeze defaults AT PROPOSE TIME (spec 5.2): a proposal filed at 23:50 and approved at
    // 00:10 must apply the date the owner consented to, not tomorrow's.
    const needsToday = body.operations.some((op) => op.type === 'progress.create' && op.occurredOn === undefined);
    const today = needsToday ? await this.todayForPlant(token.plantId) : null;
    const operations: ProposalOperation[] = body.operations.map((op) =>
      op.type === 'progress.create' && op.occurredOn === undefined ? { ...op, occurredOn: today! } : op,
    );
    assertNoOverlappingWriteSets(operations);
    assertSerializedBound(operations, 'operations');

    // Referential + ownership validation AT PROPOSE TIME, before anything is stored.
    //
    // Spec §5.5.2 makes apply time the security boundary and says so explicitly — that check stays and is
    // not weakened by this one. But propose time must ALSO reject, for the two reasons the spec itself
    // gives: the agent gets "an immediate, actionable error" instead of a proposal that will certainly
    // fail later, and "the owner never sees a malformed banner". Without this, an operation naming another
    // plant's `entryId` snapshots as `null` and renders a banner with empty before-values — asking the
    // owner to consent to a change against a record that does not exist for them. 404-shaped information
    // is never leaked: a foreign id is simply "not found for this plant".
    await this.assertOperationsReferentiallyValid(token.plantId, token.ownerId, operations);

    const snapshot = await this.snapshots.capture(token.plantId, token.ownerId, operations);
    assertSerializedBound(snapshot, 'snapshot');

    let created: DoctorWriteProposal;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Expire whatever was pending, in the SAME transaction — the agent cannot stack requests.
        await tx.doctorWriteProposal.updateMany({
          where: { sessionId: token.sessionId, status: 'PENDING' },
          data: { status: 'EXPIRED', pendingKey: null, resolvedAt: new Date(), resolvedByUserId: null },
        });
        return tx.doctorWriteProposal.create({
          data: {
            sessionId: token.sessionId,
            runId: token.runId,
            plantId: token.plantId,
            ownerId: token.ownerId,
            operations: JSON.stringify(operations),
            snapshot: JSON.stringify(snapshot),
            summary: body.summary,
            status: 'PENDING',
            pendingKey: PENDING_KEY,
          },
        });
      });
    } catch (err) {
      // The nullable-pendingKey unique index is the authority, not a find-then-insert.
      //
      // TWO Prisma codes mean "another actor holds the pending slot right now", and BOTH must become a
      // 409 — this was found against real MariaDB, not in unit tests, because a hand-thrown fake error
      // can only ever be the code the test author already thought of:
      //   P2002 — the unique violation, when the loser's INSERT reaches the index after the winner
      //           committed.
      //   P2034 — a write conflict / deadlock, which is what ACTUALLY happens ~19 times out of 20: the
      //           expire `updateMany` takes next-key locks on `(sessionId, pendingKey)` and the two
      //           overlapping transactions deadlock, so InnoDB kills one before the insert is ever
      //           attempted. Leaving this uncaught surfaced a raw driver error as a 500 to the agent
      //           instead of the actionable 409 the contract promises.
      const code = (err as { code?: string }).code;
      if (code === 'P2002' || code === 'P2034') {
        throw new ConflictException('a pending proposal already exists for this session');
      }
      throw err;
    }

    // Skip Permissions is read from the STORED setting, never from anything the agent sends — and the
    // authoritative read happens INSIDE the applier's transaction, under a row lock (spec 6.4: "read AT
    // APPLY TIME from the stored setting").
    //
    // ⚠️ Do NOT re-read it here and pass the boolean down. That is a TOCTOU window: the owner can revoke
    // between this method's read and the applier's claim, and the write then lands after the revocation
    // committed. The applier is handed the SESSION ID, not a decision, precisely so the check and the
    // write it authorizes cannot be separated. `session`, fetched at the top of this method, is stale by
    // now and must not be consulted either.
    //
    // The cheap pre-read below is an OPTIMISATION ONLY — it avoids opening a transaction for the
    // overwhelmingly common case where the mode is off. It is never trusted: if it races and says true
    // when the setting is false, the applier's locked re-read still refuses, and we fall through to the
    // owner's banner exactly as if we had never tried.
    const likelyAuto = await this.prisma.knowledgeChatSession.findUnique({
      where: { id: token.sessionId },
      select: { skipPermissions: true },
    });
    if (likelyAuto?.skipPermissions) {
      try {
        const outcome = await this.applier.apply(created, {
          actorUserId: null, // authoritative provenance is taken from the applier's own locked read
          autoApproved: true,
          requireSkipPermissionsSessionId: token.sessionId,
        });
        const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: created.id } });
        this.logger.log(`proposal ${created.id} auto-applied under skip-permissions: ${outcome.status}`);
        // ENGLISH, explicitly and unconditionally: this response is the agent's own read-back of what it
        // just did, and the audit's account of it — never owner-facing UI. It must never follow the
        // owner's `x-locale`, which is why `create()` never even accepts a locale parameter.
        return this.render.render(fresh ?? created, 'en');
      } catch (err) {
        // Revoked between the pre-read and the lock. Nothing was written and the proposal is still
        // PENDING, so the owner simply gets the normal approval banner — the correct outcome for
        // "I turned that off", and the reason this is not surfaced to the agent as an error.
        if (!(err instanceof SkipPermissionsRevokedError)) throw err;
        this.logger.log(`proposal ${created.id}: skip-permissions revoked before apply — left PENDING`);
        const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: created.id } });
        return this.render.render(fresh ?? created, 'en'); // agent-facing — see the note above
      }
    }

    return this.render.render(created, 'en'); // agent-facing — see the note above
  }

  // ---------- owner-facing ----------

  /**
   * `locale` defaults to `'en'` so every EXISTING caller of this method (unit tests, the
   * `proposals.concurrency.int.test.ts` suite) keeps its current behaviour untouched; the controller is
   * the only real caller that ever passes something else, resolved from the request's `x-locale`.
   */
  async getPending(plantId: string, sessionId: string, locale: Locale = 'en'): Promise<ProposalView | null> {
    await this.assertOwnedSession(plantId, sessionId);
    const row = await this.prisma.doctorWriteProposal.findFirst({ where: { sessionId, status: 'PENDING' } });
    return row ? this.render.render(row, locale) : null;
  }

  async approve(plantId: string, sessionId: string, proposalId: string, locale: Locale = 'en'): Promise<ProposalView> {
    const row = await this.loadOwned(plantId, sessionId, proposalId);
    const actorUserId = this.owner.currentActor()?.userId ?? null;
    try {
      await this.applier.apply(row, { actorUserId, autoApproved: false });
    } catch (err) {
      // The applier reports "somebody already resolved it" as a bare ConflictException. The owner is
      // looking at a banner for a proposal that is gone, so the 409 must say WHAT it became — EXPIRED by
      // a newer proposal reads very differently from DECLINED on another device, and the UI cannot tell
      // them apart from the message alone. `decline` already answers in this shape; an approve that did
      // not would make the two endpoints disagree about their own error contract (spec §10).
      if (err instanceof ConflictException) {
        const current = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
        throw new ConflictException({ message: 'proposal is no longer pending', status: current?.status ?? 'UNKNOWN' });
      }
      throw err;
    }
    const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
    return this.render.render(fresh ?? row, locale);
  }

  async decline(plantId: string, sessionId: string, proposalId: string, locale: Locale = 'en'): Promise<ProposalView> {
    const row = await this.loadOwned(plantId, sessionId, proposalId);
    const actorUserId = this.owner.currentActor()?.userId ?? null;

    // Recording the decision must NEVER depend on run scheduling (spec 5.3.1).
    const won = await this.prisma.$transaction(async (tx) => {
      const res = await tx.doctorWriteProposal.updateMany({
        where: { id: proposalId, status: 'PENDING' },
        data: { status: 'DECLINED', pendingKey: null, resolvedAt: new Date(), resolvedByUserId: actorUserId },
      });
      if (res.count === 1) {
        await tx.knowledgeChatSession.update({
          where: { id: sessionId },
          data: { pendingSystemMessage: SYSTEM_MESSAGE.declined, pendingSystemMessageProposalId: proposalId },
        });
      }
      return res.count;
    });
    if (won === 0) {
      const current = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
      throw new ConflictException({ message: 'proposal is no longer pending', status: current?.status ?? 'UNKNOWN' });
    }

    // Spec 5.3 step 4: a decline "enqueues the system message for delivery to the next run, STARTING THAT
    // RUN IMMEDIATELY WHEN THE SESSION IS IDLE". Queueing alone is not the contract — without this the
    // agent never learns it was declined until the owner happens to type again.
    //
    // This is deliberately AFTER the decline transaction has committed, and deliberately best-effort: the
    // decision is already durably recorded, so a launch failure must never fail the owner's click (spec
    // 5.3.1). If the session is not idle, the queued message simply waits for the next run.
    try {
      await this.chat.startQueuedSystemTurn(sessionId);
    } catch (err) {
      // A 409 here is the EXPECTED, in-contract outcome when a run is already active: the message stays
      // queued and the active run's successor will carry it — routine, so it logs at log level.
      //
      // ANYTHING ELSE IS A DEFECT AND MUST SAY SO. Swallowing every failure at the same quiet level is how
      // the 3.0.x adoption's system-message-only turn went undetected: the run insert violated the old
      // prompt-XOR-command CHECK (fixed by migration 0024), the exception landed here, and a declined
      // proposal produced no run and no visible complaint — the agent silently never learned it had been
      // declined. Still swallowed, because the decision is durably recorded and a launch failure must
      // never fail the owner's click (spec §5.3.1); but an unexpected cause is now loud in the logs.
      if (err instanceof ConflictException) {
        this.logger.log(`decline ${proposalId}: a run is already active; message stays queued`);
      } else {
        this.logger.error(
          `decline ${proposalId}: queued system turn FAILED to start (${(err as Error).message}); the message stays queued but this is not an expected outcome`,
          (err as Error).stack,
        );
      }
    }

    const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
    return this.render.render(fresh ?? row, locale);
  }

  /**
   * The ONE endpoint with two legitimate caller classes (spec 5.5.1): the effective owner, and the doctor
   * token (READ ONLY — it has no write path to this setting, §9.5). They are scoped DIFFERENTLY and must
   * not share a check:
   *   - owner → the session must belong to the effective owner (assertOwnedSession).
   *   - doctor token → the session must be EXACTLY the one pinned in the token. A doctor token must not
   *     read another session of the same plant, because that other session may have Skip Permissions on —
   *     the same reason §5.2 seals proposals to their session.
   * Matching on `plantId` alone satisfies NEITHER: it ignores `kind`, ignores the owner, and lets a doctor
   * token read a sibling session's setting.
   */
  async getSettings(
    plantId: string,
    sessionId: string,
    caller: { kind: 'owner' } | { kind: 'doctor'; token: DoctorTokenClaims },
  ): Promise<{ skipPermissions: boolean }> {
    if (caller.kind === 'doctor') {
      const t = caller.token;
      if (t.sessionId !== sessionId || t.plantId !== plantId) {
        throw new ForbiddenException('token is not pinned to this session');
      }
      const s = await this.prisma.knowledgeChatSession.findUnique({
        where: { id: sessionId },
        select: { skipPermissions: true, kind: true, plantId: true, ownerId: true },
      });
      if (!s || s.kind !== 'DOCTOR' || s.plantId !== t.plantId || s.ownerId !== t.ownerId) {
        throw new NotFoundException('session not found');
      }
      return { skipPermissions: s.skipPermissions };
    }

    // Owner path: 404 (never 403) on a foreign session — existence is not leaked (spec §9.4).
    const s = await this.assertOwnedSession(plantId, sessionId);
    return { skipPermissions: s.skipPermissions };
  }

  async setSkipPermissions(plantId: string, sessionId: string, value: boolean): Promise<{ skipPermissions: boolean }> {
    await this.assertOwnedSession(plantId, sessionId);
    await this.prisma.knowledgeChatSession.update({
      where: { id: sessionId },
      data: {
        skipPermissions: value,
        // Storing WHO enabled it and WHEN is what makes an auto-approve audit reconstructable when an
        // ADMIN is acting-as the owner (spec 6.4).
        skipPermissionsSetByUserId: value ? (this.owner.currentActor()?.userId ?? null) : null,
        skipPermissionsSetAt: value ? new Date() : null,
      },
    });
    return { skipPermissions: value };
  }

  // ---------- helpers ----------

  /**
   * Today as the OWNER's calendar sees it — resolved through the plant's place-city timezone, exactly as
   * `ProgressService` and the applier's own `todayForPlant` resolve it.
   *
   * Deliberately NOT `new Date().toISOString().slice(0, 10)`. UTC's "today" and the owner's are different
   * days for several hours of every day (from 18:00 local at UTC-6), so a proposal filed in the evening
   * would freeze TOMORROW's date and the entry would land on a day the owner never chose. The project's
   * calendar-day rule exists for precisely this defect.
   */
  private async todayForPlant(plantId: string): Promise<string> {
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId },
      select: { place: { select: { city: { select: { timezone: true } } } } },
    });
    return ymdFromUtcDate(startOfTodayUtc(plant?.place?.city?.timezone ?? 'UTC'));
  }

  /**
   * Every id an operation references must belong to the PINNED plant/owner. Rejects with 400 so the agent
   * gets an actionable error it can correct and re-propose (a 403/404 would read to the agent as "you may
   * not do this at all" rather than "that id is wrong").
   *
   * This runs at PROPOSE time. It is NOT a substitute for the apply-time re-check inside the transaction
   * (§5.5.2) — the world can change between the two — it is what stops a doomed or misleading proposal
   * from ever reaching the owner's banner.
   */
  private async assertOperationsReferentiallyValid(
    plantId: string,
    ownerId: string,
    operations: ProposalOperation[],
  ): Promise<void> {
    const entryIds = [
      ...new Set(
        operations.flatMap((op) => (op.type === 'progress.update' || op.type === 'progress.delete' ? [op.entryId] : [])),
      ),
    ];
    if (entryIds.length) {
      const found = await this.prisma.plantProgressEntry.findMany({
        where: { id: { in: entryIds }, plantId },
        select: { id: true },
      });
      const ok = new Set(found.map((e) => e.id));
      const missing = entryIds.filter((id) => !ok.has(id));
      if (missing.length) {
        throw new BadRequestException(`progress entry not found on this plant: ${missing.join(', ')}`);
      }
    }

    const placeIds = [
      ...new Set(operations.flatMap((op) => (op.type === 'plant.update' && op.placeId ? [op.placeId] : []))),
    ];
    if (placeIds.length) {
      // Owner-scoped: moving the plant to a place owned by someone else is not a "not found" edge case, it
      // is the cross-owner move spec §5.5.2 forbids.
      const found = await this.prisma.place.findMany({
        where: { id: { in: placeIds }, ownerId },
        select: { id: true },
      });
      const ok = new Set(found.map((p) => p.id));
      const missing = placeIds.filter((id) => !ok.has(id));
      if (missing.length) {
        throw new BadRequestException(`place not found for this owner: ${missing.join(', ')}`);
      }
    }
  }

  /** Returns the session so callers do not re-query it. 404 (never 403) — existence is not leaked. */
  private async assertOwnedSession(plantId: string, sessionId: string) {
    const s = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
    if (!s || s.kind !== 'DOCTOR' || s.plantId !== plantId || s.ownerId !== this.owner.currentOwnerId()) {
      throw new NotFoundException('session not found');
    }
    return s;
  }

  private async loadOwned(plantId: string, sessionId: string, proposalId: string): Promise<DoctorWriteProposal> {
    await this.assertOwnedSession(plantId, sessionId);
    const row = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
    // 404, never 403 — existence is not leaked (spec 9.4).
    if (
      !row ||
      row.sessionId !== sessionId ||
      row.plantId !== plantId ||
      row.ownerId !== this.owner.currentOwnerId()
    ) {
      throw new NotFoundException('proposal not found');
    }
    return row;
  }
}
