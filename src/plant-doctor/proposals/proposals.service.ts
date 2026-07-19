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
import { ProposalRenderService, type ProposalView } from './proposal-render.service.js';
import { ProposalApplierService } from './proposal-applier.service.js';
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
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('a pending proposal already exists for this session');
      }
      throw err;
    }

    // Skip Permissions is read from the STORED setting, never from anything the agent sends — and it is
    // RE-READ HERE, immediately before applying (spec 6.4: "read AT APPLY TIME from the stored setting").
    // The `session` fetched at the top of this method is stale by now: the owner may have flipped the
    // switch off while the proposal was being validated and snapshotted. Auto-applying on that stale read
    // would write to the plant after the owner revoked the authorization to do so — the single worst
    // failure this feature can have. Re-read the setting AND its provenance together.
    const current = await this.prisma.knowledgeChatSession.findUnique({
      where: { id: token.sessionId },
      select: { skipPermissions: true, skipPermissionsSetByUserId: true },
    });
    if (current?.skipPermissions) {
      const outcome = await this.applier.apply(created, {
        actorUserId: current.skipPermissionsSetByUserId,
        autoApproved: true,
      });
      const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: created.id } });
      this.logger.log(`proposal ${created.id} auto-applied under skip-permissions: ${outcome.status}`);
      return this.render.render(fresh ?? created);
    }

    return this.render.render(created);
  }

  // ---------- owner-facing ----------

  async getPending(plantId: string, sessionId: string): Promise<ProposalView | null> {
    await this.assertOwnedSession(plantId, sessionId);
    const row = await this.prisma.doctorWriteProposal.findFirst({ where: { sessionId, status: 'PENDING' } });
    return row ? this.render.render(row) : null;
  }

  async approve(plantId: string, sessionId: string, proposalId: string): Promise<ProposalView> {
    const row = await this.loadOwned(plantId, sessionId, proposalId);
    const actorUserId = this.owner.currentActor()?.userId ?? null;
    await this.applier.apply(row, { actorUserId, autoApproved: false });
    const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
    return this.render.render(fresh ?? row);
  }

  async decline(plantId: string, sessionId: string, proposalId: string): Promise<ProposalView> {
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
      // queued and the active run's successor will carry it. Anything else is logged and swallowed.
      this.logger.log(`decline ${proposalId}: no turn started (${(err as Error).message}); message stays queued`);
    }

    const fresh = await this.prisma.doctorWriteProposal.findUnique({ where: { id: proposalId } });
    return this.render.render(fresh ?? row);
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
