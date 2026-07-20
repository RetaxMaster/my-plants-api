import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AgentCommand, AgentProvider, SessionHistory } from '@retaxmaster/agents-realtime-protocol';
import { SessionNotFoundError } from '@retaxmaster/agents-realtime-server';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ChatEngineRegistry } from './engine/chat-engine-registry.js';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';
import { CodexRoleVerificationService } from './codex-role-verification.service.js';
import { DoctorRunContextService } from '../plant-doctor/doctor-run-context.service.js';
import { resolveEffectiveProvider } from './effective-provider.js';
import { WORKSPACE_ENV } from './doctor-workspace-env.js';
import { type SessionScope, whereForScope, sessionMatchesScope } from './session-scope.js';
import type { AttachmentDto } from './knowledge-chat.dto.js';
import { SYSTEM_MESSAGE } from './system-message.js';
import { splitStoredPrompt } from './legacy-prompt-split.js';
import { ACTIVE_RUN_STATUSES } from './run-status.js';
import { takeLaunchLease } from './launch-lease.js';
import { classifyLaunchFailure, restoreOnPreSpawnFailure, settleConsumedMessage } from './system-message-delivery.js';

// The engine's typed "there is nothing left to read" errors. Classified against the package's own error
// classes rather than by matching message text, so a reworded message cannot silently turn a real outage
// into a fake "empty transcript".
function isHistoryGone(err: unknown): boolean {
  return err instanceof SessionNotFoundError;
}

// Our history envelope: the package's canonical SessionHistory, plus the one fact only WE can report —
// that the agent itself no longer holds this session, so the conversation is un-continuable.
export type KnowledgeChatHistory = SessionHistory & { agentSessionMissing?: boolean };

// What a turn actually carries. The XOR is the contract, and it is the same one the wire and the DB enforce.
// Attachments are NOT persisted on the run row (spec §4.1.1 — no column, deliberately): they thread through
// this in-memory input straight to `launch()`'s extra parameter, never through `admitRun`/`insertActiveRun`.
export type TurnInput =
  | { prompt: string; attachments?: AttachmentDto[]; command?: never }
  | { command: AgentCommand; prompt?: never; attachments?: never };

type SessionKind = 'KNOWLEDGE' | 'DOCTOR';

// ONE source of truth, shared with the orchestrator and the doctor cleanup (see run-status.ts).
const ACTIVE = ACTIVE_RUN_STATUSES;
// The value in `activeKey` while a run is non-terminal. Cleared to null on every terminal transition. The
// @@unique([sessionId, activeKey]) constraint then permits at most ONE active run per session.
const ACTIVE_KEY = 'ACTIVE';
type KnowledgeChatRunRow = {
  id: string;
  sessionId: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  // Reconciliation needs these: whether the run reached the agent, and what message (if any) it consumed.
  providerSessionId: string | null;
  systemMessageText: string | null;
  systemMessageProposalId: string | null;
  systemMessageState: string | null;
};

/**
 * The ordered admission transaction (spec 5.5.4). ONE transaction, in this order:
 *   1. conditionally expire the session's PENDING proposal
 *   2. if that expiry took effect, queue the "still has not approved" nudge
 *   3. consume the queued message onto the run row's OWN systemMessageText column — never onto `prompt`
 *      — SKIPPED for a command turn: prompt and command are a strict XOR, and prefixing prose onto a
 *        command corrupts it. The message waits for the next PROMPT turn.
 *   4. insert the run with its activeKey
 *
 * Sharing ONE transaction is the whole point: it stops an approve from landing AFTER the run was admitted
 * but BEFORE the expiry, which would apply a write the owner's new turn had already superseded.
 *
 * Exported as a module-level function (not a method) so the ordering can be unit-tested directly against a
 * transaction client, without standing up the whole service.
 */
export async function admitRun(
  tx: Prisma.TransactionClient,
  args: { sessionId: string; provider: AgentProvider; input: TurnInput },
) {
  const expired = await tx.doctorWriteProposal.updateMany({
    where: { sessionId: args.sessionId, status: 'PENDING' },
    data: { status: 'EXPIRED', pendingKey: null, resolvedAt: new Date(), resolvedByUserId: null },
  });

  const session = await tx.knowledgeChatSession.findUnique({ where: { id: args.sessionId } });

  let queuedText = session?.pendingSystemMessage ?? null;
  let queuedProposalId = session?.pendingSystemMessageProposalId ?? null;
  if (expired.count > 0) {
    // A newer message REPLACES an older one — and its proposal id goes with it, or the run would carry a
    // message about one proposal tagged with the id of another.
    queuedText = SYSTEM_MESSAGE.notApproved;
    queuedProposalId = null;
    await tx.knowledgeChatSession.update({
      where: { id: args.sessionId },
      data: { pendingSystemMessage: queuedText, pendingSystemMessageProposalId: null },
    });
  }

  const isCommand = args.input.command !== undefined;
  const consume = !isCommand && queuedText !== null;

  if (consume) {
    // Consuming and inserting share this transaction, so a crash between them cannot duplicate the
    // message nor strand it (at-most-once, spec 5.5.4).
    await tx.knowledgeChatSession.update({
      where: { id: args.sessionId },
      data: { pendingSystemMessage: null, pendingSystemMessageProposalId: null },
    });
  }

  // The system message NO LONGER touches the prompt (spec §3.1). It rides its own column here and its own
  // out-of-band `systemMessage` field on the wire, so `prompt` means exactly "what the user typed" — and a
  // message-only turn stores NULL rather than the empty string that used to reach the agent as a blank turn.
  const rawUserText = args.input.command ? null : (args.input.prompt ?? null);
  const userText = rawUserText === '' ? null : rawUserText;
  const prompt = isCommand ? null : userText;

  return tx.knowledgeChatRun.create({
    data: {
      sessionId: args.sessionId,
      provider: args.provider,
      prompt,
      // The raw argument string, verbatim — the exact shape this column has always held. Serializing it
      // would double-encode every command turn.
      commandName: args.input.command?.name ?? null,
      commandArgs: args.input.command?.args ?? null,
      status: 'QUEUED',
      activeKey: ACTIVE_KEY,
      // The consumed message moves ONTO THE RUN ROW so it is never in limbo between "removed from the
      // session" and "restored". CONSUMED is the only non-terminal state.
      systemMessageText: consume ? queuedText : null,
      systemMessageProposalId: consume ? queuedProposalId : null,
      systemMessageState: consume ? 'CONSUMED' : null,
    },
  });
}

/**
 * Reader 1 of the MIXED `prompt` column (spec §3.1.1). Exported as a module-level function so the
 * de-concatenation can be unit-tested without standing up the service.
 *
 * The rule runs HERE, server-side, rather than in the browser: it needs `systemMessageText`, which
 * `KnowledgeChatTurn` does not carry and cannot derive — resolving it client-side would mean adding the
 * column to the chat contract on both the admin and diagnose routes. So the raw concatenation never
 * reaches the wire, and the contract gains no key.
 */
export function mapRunToTurn(
  run: {
    id: string;
    prompt: string | null;
    systemMessageText: string | null;
    commandName: string | null;
    commandArgs: string | null;
    status: string;
  },
  logBase: string,
) {
  const split = splitStoredPrompt(run.prompt, run.systemMessageText);
  return {
    runId: run.id,
    prompt: split ? split.userMessage : run.prompt,
    command: run.commandName ? { name: run.commandName, args: run.commandArgs ?? '' } : null,
    status: run.status,
    isActive: (ACTIVE as readonly string[]).includes(run.status),
    logUrl: `${logBase}/runs/${run.id}/log`,
  };
}

@Injectable()
export class KnowledgeChatService {
  private readonly logger = new Logger(KnowledgeChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engines: ChatEngineRegistry,
    private readonly tickets: KnowledgeChatTicketService,
    private readonly owner: OwnerService,
    private readonly doctorRunContext: DoctorRunContextService,
    private readonly codexVerification: CodexRoleVerificationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // A run's log lives under ITS engine's log dir (KNOWLEDGE vs DOCTOR), resolved via the registry — never a
  // single hard-coded dir, or a doctor run's log would be written under the KE's logRoot and rejected.
  private logPath(kind: SessionKind, runId: string): string {
    return join(this.engines.logDirFor(kind), `${runId}.ndjson`);
  }

  // Refuse a codex run whose engine has not verified its Codex role loading (Spec 3 §3.2, fail-closed). The
  // gate is on the run-path-resolved (sealed-aware) provider, so a resume of a sealed codex session is
  // refused whether the DTO omits `provider` or sends a misleading `provider:'claude'`.
  private async assertCodexAllowed(kind: SessionKind, provider: AgentProvider): Promise<void> {
    if (provider !== 'codex') return;
    if (await this.codexVerification.isVerified(kind)) return;
    throw new UnprocessableEntityException('Codex is unavailable for this pipeline (roles not verified).');
  }

  private isStale(run: KnowledgeChatRunRow): boolean {
    const anchor = (run.startedAt ?? run.createdAt).getTime();
    return Date.now() - anchor > this.env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS + this.env.KNOWLEDGE_CHAT_RUN_BUFFER_MS;
  }

  private async reconcileStaleActive(sessionId: string): Promise<void> {
    const active = (await this.prisma.knowledgeChatRun.findMany({
      where: { sessionId, activeKey: ACTIVE_KEY },
    })) as unknown as KnowledgeChatRunRow[];
    for (const run of active) {
      if (this.isStale(run)) {
        // Settling the run and settling any message it consumed share ONE transaction: a stale run that
        // never reached the agent must give its message back before its slot is freed, or the next run is
        // admitted without it.
        await this.prisma.$transaction(async (tx) => {
          await tx.knowledgeChatRun.updateMany({
            where: { id: run.id, status: { in: [...ACTIVE] } },
            data: { status: 'FAILED', finishedAt: new Date(), error: 'Reconciled: run went stale.', activeKey: null },
          });
          // `providerSessionId` being set is this repo's existing signal that the run reached the agent
          // and produced output; a stale run without one never got that far.
          await settleConsumedMessage(tx, run, { producedAgentTurn: run.providerSessionId !== null });
        });
      }
    }
    await this.reconcileStrandedConsumed(sessionId);
  }

  /**
   * Settle a message stranded on an ALREADY-TERMINAL run.
   *
   * ⚠️ WITHOUT THIS, THE `AMBIGUOUS` BRANCH IS A PERMANENT SILENT DROP — not the deferral it claims to be.
   *
   * `launchRun`'s AMBIGUOUS path deliberately leaves the message `CONSUMED` and marks the run FAILED with
   * `activeKey: null`, on the stated reasoning that "reconciliation will settle it once it can establish
   * whether a turn was produced". That reasoning had no implementation behind it. There are exactly two
   * settlers of a CONSUMED message, and neither can ever see such a run again:
   *
   *   1. `reconcileStaleActive` queries `activeKey: ACTIVE_KEY` — the AMBIGUOUS branch just nulled it.
   *   2. the orchestrator's `runFinished` fires on the ENGINE's terminal callback — which never comes,
   *      because the whole premise of the failure is that the engine may never have received the run.
   *
   * So the notice sat in `CONSUMED` forever, the session slot stayed empty, and the owner's decline was
   * never relayed to the agent — the exact symptom this feature exists to end, one layer down. Spec §5.5.4's
   * invariant ("a queued message is never silently dropped") was false on every AMBIGUOUS outcome.
   *
   * **Why it is gated on staleness, and why that is required for at-most-once.** An AMBIGUOUS failure means
   * the run MAY have spawned and be running right now. Settling immediately could restore a message the
   * agent has already read, which it receives as a second refusal for the same proposal — the duplication
   * the whole classification exists to prevent. Waiting for the run-timeout window means a genuinely spawned
   * run has had its full life to report; after it, `providerSessionId` is a settled fact rather than a race.
   * `transitionConsumed`'s conditional update still elects a single winner, so a late callback racing this
   * sweep is safe either way.
   */
  private async reconcileStrandedConsumed(sessionId: string): Promise<void> {
    const stranded = (await this.prisma.knowledgeChatRun.findMany({
      where: { sessionId, activeKey: null, systemMessageState: 'CONSUMED' },
    })) as unknown as KnowledgeChatRunRow[];
    for (const run of stranded) {
      if (!this.isStale(run)) continue;
      await this.prisma.$transaction(async (tx) => {
        // Same signal reconcileStaleActive uses: a run that never reached the agent never got a provider
        // session id, so its message was never read and goes back on the session.
        await settleConsumedMessage(tx, run, { producedAgentTurn: run.providerSessionId !== null });
      });
    }
  }

  // Atomically claim the single active slot: reconcile a stale run, then INSERT a new run holding
  // activeKey='ACTIVE'. Concurrency is decided by the DB unique constraint — a racing second insert hits
  // P2002 and becomes a 409. See the long-form comments preserved in git history for the seal-claim TOCTOU.
  private async insertActiveRun(
    sessionId: string,
    provider: AgentProvider,
    input: TurnInput,
    opts?: { onlyWhileUnsealed?: boolean },
  ): Promise<string | null> {
    await this.reconcileStaleActive(sessionId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (opts?.onlyWhileUnsealed) {
          const { count } = await tx.knowledgeChatSession.updateMany({
            where: { id: sessionId, providerSessionId: null },
            data: { provider },
          });
          if (count === 0) return null; // sealed in the gap → this is no longer a retry
        }
        // Admission is ORDERED and shares this transaction (spec 5.5.4) — see admitRun.
        const run = await admitRun(tx, { sessionId, provider, input });
        await tx.knowledgeChatSession.update({
          where: { id: sessionId },
          data: { pendingRunId: run.id },
        });
        return run.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A run is already in progress for this session');
      }
      throw err;
    }
  }

  /**
   * Start a turn whose ENTIRE input is the queued system message (spec 5.3 step 4: a decline "starts that
   * run immediately when the session is idle"). `ProposalsService.decline` is the ONLY caller.
   *
   * Deliberately NOT a special path: it goes through the same admission + launch the owner's own prompt
   * turns use, so the message is consumed by `admitRun`'s ordered transaction (expire → queue → consume →
   * insert) and inherits at-most-once delivery, the activeKey guard and the launch lease for free. A
   * second implementation of "start a run" is exactly the fork the project rules forbid.
   *
   * Idle is NOT pre-checked with a read — that would be a TOCTOU race against a run starting concurrently.
   * The activeKey unique index is the authority: if a run is already active the insert violates it and
   * this throws ConflictException, which the caller treats as "the message stays queued". No message is
   * lost: it is still on the session, and the active run's successor will carry it.
   */
  async startQueuedSystemTurn(sessionId: string): Promise<string | null> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
    // Nothing queued (e.g. it was already consumed by a turn the owner just sent) → nothing to start.
    if (!session?.pendingSystemMessage) return null;
    // An unsealed session has no providerSessionId yet, so there is no agent thread to continue. The
    // message simply waits for the owner's first real turn.
    if (!session.providerSessionId) return null;

    const kind = session.kind as SessionKind;
    const provider = session.provider as AgentProvider;
    await this.assertCodexAllowed(kind, provider);

    // The EMPTY prompt is intentional: admitRun consumes the queued message and PREFIXES it onto the
    // run's persisted prompt. Passing the text here as well would deliver it twice and break the
    // at-most-once guarantee of spec 5.5.4.
    const input: TurnInput = { prompt: '' };

    // insertActiveRun returns string | null — null means it lost the active-slot race, which is the
    // in-contract "a run is already active" outcome: the message stays queued for that run's successor.
    // It can also throw ConflictException on P2002; the caller treats both the same way.
    const runId = await this.insertActiveRun(sessionId, provider, input);
    if (!runId) return null;

    await this.launch(runId, provider, session.providerSessionId, kind, session, undefined);
    return runId;
  }

  async listSessions(scope: SessionScope) {
    const sessions = await this.prisma.knowledgeChatSession.findMany({
      where: whereForScope(scope),
      orderBy: { createdAt: 'desc' },
      include: { runs: { orderBy: { createdAt: 'desc' } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      provider: s.provider,
      providerSessionId: s.providerSessionId,
      title: s.title,
      // Truthful read-model fields the web's optional kind/plantId lean on (KE → KNOWLEDGE/null).
      kind: s.kind,
      plantId: s.plantId,
      status: s.runs[0]?.status ?? null,
      turns: s.runs.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  async getSession(id: string, scope: SessionScope) {
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { id },
      include: { runs: { orderBy: { createdAt: 'asc' } } },
    });
    // A session from another plant/owner/kind is indistinguishable from "not found" (Spec 3 §3.2).
    if (!session || !sessionMatchesScope(session, scope)) throw new NotFoundException(`Unknown session: ${id}`);
    const logBase = session.kind === 'DOCTOR' ? `/plants/${session.plantId}/diagnose` : '/knowledge-chat';
    return {
      id: session.id,
      title: session.title,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      kind: session.kind,
      plantId: session.plantId,
      turns: session.runs.map((r) => mapRunToTurn(r, logBase)),
    };
  }

  // The AGENT is chosen here, once, and every later turn reuses it. The scope stamps kind/plantId/ownerId so
  // the same method serves both the KE controller ({kind:'KNOWLEDGE'}) and the doctor controller
  // ({kind:'DOCTOR', plantId, ownerId}).
  async createSession(
    prompt: string,
    provider: AgentProvider,
    scope: SessionScope,
    attachments?: AttachmentDto[],
  ): Promise<{ sessionId: string; runId: string; ticket: string }> {
    // Codex gate BEFORE we create anything (isCreate → the create provider is the effective one).
    await this.assertCodexAllowed(scope.kind, resolveEffectiveProvider({ isCreate: true, sealed: false, requestProvider: provider }));
    const actor = this.owner.currentActor();
    const title = prompt.slice(0, 160);
    const session = await this.prisma.knowledgeChatSession.create({
      data: {
        title,
        provider,
        createdByUserId: actor?.userId ?? null,
        kind: scope.kind,
        plantId: scope.kind === 'DOCTOR' ? scope.plantId : null,
        ownerId: scope.kind === 'DOCTOR' ? scope.ownerId : null,
      },
    });
    const runId = (await this.insertActiveRun(session.id, provider, { prompt, attachments }))!;
    const ticket = await this.launch(runId, provider, null, scope.kind, session, attachments);
    return { sessionId: session.id, runId, ticket };
  }

  async resume(
    sessionId: string,
    input: TurnInput,
    provider: AgentProvider | undefined,
    scope: SessionScope,
  ): Promise<{ runId: string; ticket: string }> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
    if (!session || !sessionMatchesScope(session, scope)) throw new NotFoundException(`Unknown session: ${sessionId}`);

    if (!session.providerSessionId) {
      if (input.command) {
        throw new UnprocessableEntityException(
          'A command needs an established agent session — send a message first.',
        );
      }
      const retryProvider = provider ?? (session.provider as AgentProvider);
      // Codex gate on the effective provider (unsealed retry → request ?? session provider).
      await this.assertCodexAllowed(scope.kind, resolveEffectiveProvider({
        isCreate: false, sealed: false, sessionProvider: session.provider as AgentProvider, requestProvider: provider,
      }));
      const runId = await this.insertActiveRun(sessionId, retryProvider, input, { onlyWhileUnsealed: true });
      if (runId) {
        const ticket = await this.launch(runId, retryProvider, null, scope.kind, session, input.attachments);
        return { runId, ticket };
      }
      // Lost the race: a session appeared while we were claiming. Continue it on ITS agent.
      const settled = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      if (!settled?.providerSessionId) throw new NotFoundException(`Unknown session: ${sessionId}`);
      session.provider = settled.provider;
      session.providerSessionId = settled.providerSessionId;
    }

    // Sealed: the agent is FINAL; the request `provider` is ignored. Gate on the sealed provider.
    const sessionProvider = session.provider as AgentProvider;
    await this.assertCodexAllowed(scope.kind, resolveEffectiveProvider({
      isCreate: false, sealed: true, sessionProvider, requestProvider: provider,
    }));
    const runId = (await this.insertActiveRun(sessionId, sessionProvider, input))!;
    const ticket = await this.launch(runId, sessionProvider, session.providerSessionId!, scope.kind, session, input.attachments);
    return { runId, ticket };
  }

  // Name the log file, mint a ticket, trigger /execute — routed to the engine for this session's kind. On
  // engine failure mark the run FAILED immediately AND clear activeKey. For a DOCTOR run, the per-session
  // workspace + doctor-context.json + scoped token are prepared BEFORE execute() and the workspace path is
  // injected as PLANT_DOCTOR_SESSION_WORKSPACE via the per-run env (Task-2 seam).
  /**
   * SPEC §3.1.1 — the last mile reads the ADMITTED RUN ROW, never the caller's argument.
   *
   * This used to take the caller's `input` and send `input.prompt`. That was the live defect: `admitRun`
   * composed and persisted the turn, and then `launch` sent something else — so the queued system message
   * was consumed, marked CONSUMED, and never reached the agent, while a decline-triggered turn (whose
   * caller passes an empty prompt) delivered an empty turn. The run row is the custody the at-most-once
   * protocol already maintains, so it is the only correct source. Do NOT reintroduce an `input` parameter.
   */
  private async launch(
    runId: string,
    provider: AgentProvider,
    resumeSessionId: string | null,
    kind: SessionKind,
    session: { id: string; plantId?: string | null; ownerId?: string | null },
    // Attachments are the ONE thing that legitimately cannot come from the admitted run row — they are
    // deliberately not persisted (spec §4.1.1, no column). Everything else `launch()` sends still comes
    // from the row read below; do NOT widen this into a full `input` parameter (see the note above).
    attachments: AttachmentDto[] | undefined,
  ): Promise<string> {
    const logPath = this.logPath(kind, runId);
    try {
      await mkdir(this.engines.logDirFor(kind), { recursive: true });
      let perRunEnv: Record<string, string> | undefined;
      if (kind === 'DOCTOR') {
        // The scoped token represents the OWNER of the pinned plant (role USER), NOT whoever is operating the
        // chat — an ADMIN acting-as an owner must still mint a token whose sub/username identify that owner's
        // user (Spec 3 §3.3), or the token's subject would be inconsistent with its ownerId. User.ownerId is
        // @unique, so there is exactly one such user.
        const ownerUser = await this.prisma.user.findUnique({ where: { ownerId: session.ownerId! } });
        if (!ownerUser) throw new Error(`DOCTOR session ${session.id}: owner ${session.ownerId} has no user`);
        const { workspaceDir } = await this.doctorRunContext.prepareRun({
          sessionId: session.id,
          runId,
          plantId: session.plantId!,
          ownerId: session.ownerId!,
          userId: ownerUser.id,
          username: ownerUser.username,
        });
        perRunEnv = { [WORKSPACE_ENV]: workspaceDir };
      }
      const ticket = await this.tickets.mint(runId);

      // THE LEASE (spec §8.1). Everything above — workspace prep, token mint, ticket — is real async work
      // during which a deploy can drain and cancel this run. Only a run that wins QUEUED -> LAUNCHING here,
      // with the verification record still reading true in the SAME transaction, may call /execute.
      const leased = await takeLaunchLease(this.prisma, runId, () =>
        provider === 'codex' ? this.codexVerification.isVerified(kind) : Promise.resolve(true),
      );
      if (!leased) {
        // A refused lease is a CONFIRMED pre-spawn outcome — /execute has demonstrably not been called —
        // so any system message this run consumed goes back on the session for its successor to carry.
        // (The catch below will also fire on the throw; its conditional update matches 0 rows because the
        // run is already terminal here, so it is a no-op.)
        await this.prisma.$transaction((tx) =>
          restoreOnPreSpawnFailure(tx, runId, 'Run refused the launch lease (cancelled, or the engine is draining).'),
        );
        throw new ConflictException('run could not acquire the launch lease');
      }

      // Read the row admitted in the same transaction. `prompt` is the user's text (or null on a
      // message-only turn) and `systemMessageText` is the message this run claimed from its session.
      // NOTE: there is deliberately no attachment column on the run row (spec §4.1.1) — attachments are
      // threaded through in memory, so do not add `attachments` to this select.
      const row = await this.prisma.knowledgeChatRun.findUnique({
        where: { id: runId },
        select: { prompt: true, systemMessageText: true, commandName: true, commandArgs: true },
      });
      if (!row) throw new Error(`Run ${runId} vanished between admission and launch`);

      await this.engines.engineFor(kind).execute(
        row.commandName
          ? {
              runId,
              provider,
              command: { name: row.commandName, args: row.commandArgs ?? '' },
              logPath,
              resumeSessionId,
              env: perRunEnv,
            }
          : {
              runId,
              provider,
              prompt: row.prompt,
              // Omission is the contract — an absent system message must be ABSENT, never
              // present-and-empty, which the package would read as a sentinel that looks like data.
              ...(row.systemMessageText ? { systemMessage: row.systemMessageText } : {}),
              // Same omission contract as systemMessage above: an absent attachment list must be ABSENT,
              // never present-and-empty.
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
              logPath,
              resumeSessionId,
              env: perRunEnv,
            },
      );
      return ticket;
    } catch (err) {
      // A launch failure may or may not have left a spawned run behind, and a run may be carrying a
      // CONSUMED system message. Restoring blindly would re-deliver it (spec 5.5.4), so the classification
      // decides: only a CONFIRMED pre-spawn failure puts the message back.
      const failure = classifyLaunchFailure(err);
      await this.prisma.$transaction(async (tx) => {
        if (failure === 'PRE_SPAWN') {
          await restoreOnPreSpawnFailure(tx, runId, `Launch failed: ${(err as Error).message}`);
        } else {
          // AMBIGUOUS: do NOT restore. Leave the message CONSUMED on the run row; `reconcileStrandedConsumed`
          // settles it once the run-timeout window has passed and `providerSessionId` is a settled fact
          // rather than a race. That sweep is what makes this branch a genuine DEFERRAL — without it,
          // nulling `activeKey` below puts the run out of reach of every settler and the message is dropped
          // silently and permanently. Do not remove one without the other.
          await tx.knowledgeChatRun.updateMany({
            where: { id: runId, status: { in: [...ACTIVE] } },
            data: {
              status: 'FAILED',
              finishedAt: new Date(),
              error: `Launch failed: ${(err as Error).message}`,
              activeKey: null,
            },
          });
        }
      });
      throw err;
    }
  }

  // Delete a session. For a DOCTOR session, sweep the FS (workspace + logs) FIRST and only delete the row if
  // the sweep succeeds — never leave a workspace (which holds a scoped token) whose locating row is gone
  // (Spec 3 §3.1, same ordering the plant-delete purge uses).
  async deleteSession(id: string, scope: SessionScope): Promise<{ ok: true }> {
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { id },
      include: { runs: true },
    });
    if (!session || !sessionMatchesScope(session, scope)) throw new NotFoundException(`Unknown session: ${id}`);
    const active = session.runs.find(
      (r) => (ACTIVE as readonly string[]).includes(r.status) && !this.isStale(r),
    );
    if (active) throw new ConflictException('Cannot delete a session with an active run');
    const kind = session.kind as SessionKind;
    // Sweep FS first (best-effort logs are runtime artifacts, but for DOCTOR the workspace holds a token, so
    // if the sweep THROWS we abort before deleting the row — retryable, never a silent orphan).
    if (kind === 'DOCTOR') {
      await this.doctorRunContext.sweep(id);
    }
    await Promise.all(session.runs.map((r) => rm(this.logPath(kind, r.id), { force: true })));
    await this.prisma.knowledgeChatSession.delete({ where: { id } });
    return { ok: true };
  }

  async getSessionHistory(id: string, scope: SessionScope): Promise<KnowledgeChatHistory> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id } });
    if (!session || !sessionMatchesScope(session, scope)) throw new NotFoundException(`Unknown session: ${id}`);
    if (!session.providerSessionId) {
      throw new UnprocessableEntityException('Session has no agent session yet (its first run never started one)');
    }
    const provider = session.provider as AgentProvider;
    try {
      return await this.engines.engineFor(session.kind as SessionKind).loadHistory(provider, session.providerSessionId);
    } catch (err) {
      if (!isHistoryGone(err)) throw err;
      this.logger.warn(
        `Chat session ${id}: transcript no longer available (${(err as Error).message}) — serving an empty history.`,
      );
      return { provider, providerSessionId: session.providerSessionId, turns: [], agentSessionMissing: true };
    }
  }

  async getRunLog(runId: string, scope: SessionScope): Promise<string> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId }, include: { session: true } });
    // A run whose session belongs to another plant/owner/kind is indistinguishable from "not found" (Spec 3
    // §3.2) — the KE admin surface must never read a DOCTOR transcript, and vice versa.
    if (!run || !sessionMatchesScope(run.session, scope)) throw new NotFoundException(`Unknown run: ${runId}`);
    try {
      return await readFile(this.logPath(run.session.kind as SessionKind, runId), 'utf8');
    } catch {
      throw new NotFoundException('Transcript log not found');
    }
  }

  async mintSocketTicket(runId: string, scope: SessionScope): Promise<{ ticket: string }> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId }, include: { session: true } });
    // A runId whose session belongs to another plant/owner/kind 404s (Spec 3 §3.2).
    if (!run || !sessionMatchesScope(run.session, scope)) throw new NotFoundException(`Unknown run: ${runId}`);
    return { ticket: await this.tickets.mint(runId) };
  }

  // Cancel a live run, then reconcile its row. agents-realtime v2.4 exposes NO host-facing cancel API —
  // cancellation is engine-internal (the runner is a DETACHED process-group leader the engine SIGTERMs by
  // pid, then escalates). So the honest, minimal stop is a best-effort cooperative SIGTERM to that leader
  // (Phase A of the engine's own reap), guarded so a dead/absent pid is a no-op. We then reconcile the row
  // to CANCELLED and free the active slot — idempotent with the engine's own runFinished callback
  // (single-winner via the active-status guard). Used by the plant-delete purge (Spec 3 §3.1) so a row is
  // never yanked out from under a live run. NOTE: a first-class host cancel API is a future package change.
  async cancelRun(runId: string): Promise<void> {
    const run = (await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId } })) as
      | (KnowledgeChatRunRow & { pid: number | null })
      | null;
    if (!run) return;
    if ((ACTIVE as readonly string[]).includes(run.status) && typeof run.pid === 'number') {
      try {
        process.kill(run.pid, 'SIGTERM'); // cooperative stop of the run's leader; best-effort
      } catch {
        // Already gone (ESRCH) or not permitted — the reconcile below still frees the slot.
      }
    }
    await this.prisma.knowledgeChatRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), pid: null, activeKey: null },
    });
  }
}
