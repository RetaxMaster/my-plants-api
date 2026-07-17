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
export type TurnInput = { prompt: string; command?: never } | { command: AgentCommand; prompt?: never };

type SessionKind = 'KNOWLEDGE' | 'DOCTOR';

const ACTIVE = ['QUEUED', 'RUNNING'] as const;
// The value in `activeKey` while a run is non-terminal. Cleared to null on every terminal transition. The
// @@unique([sessionId, activeKey]) constraint then permits at most ONE active run per session.
const ACTIVE_KEY = 'ACTIVE';
type KnowledgeChatRunRow = { id: string; status: string; startedAt: Date | null; createdAt: Date };

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
        await this.prisma.knowledgeChatRun.updateMany({
          where: { id: run.id, status: { in: [...ACTIVE] } },
          data: { status: 'FAILED', finishedAt: new Date(), error: 'Reconciled: run went stale.', activeKey: null },
        });
      }
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
        const run = await tx.knowledgeChatRun.create({
          data: {
            sessionId,
            provider,
            prompt: input.command ? null : input.prompt,
            commandName: input.command?.name ?? null,
            commandArgs: input.command?.args ?? null,
            status: 'QUEUED',
            activeKey: ACTIVE_KEY,
          },
        });
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
      turns: session.runs.map((r) => ({
        runId: r.id,
        prompt: r.prompt,
        command: r.commandName ? { name: r.commandName, args: r.commandArgs ?? '' } : null,
        status: r.status,
        isActive: (ACTIVE as readonly string[]).includes(r.status),
        logUrl: `${logBase}/runs/${r.id}/log`,
      })),
    };
  }

  // The AGENT is chosen here, once, and every later turn reuses it. The scope stamps kind/plantId/ownerId so
  // the same method serves both the KE controller ({kind:'KNOWLEDGE'}) and the doctor controller
  // ({kind:'DOCTOR', plantId, ownerId}).
  async createSession(
    prompt: string,
    provider: AgentProvider,
    scope: SessionScope,
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
    const runId = (await this.insertActiveRun(session.id, provider, { prompt }))!;
    const ticket = await this.launch(runId, provider, { prompt }, null, scope.kind, session);
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
        const ticket = await this.launch(runId, retryProvider, input, null, scope.kind, session);
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
    const ticket = await this.launch(runId, sessionProvider, input, session.providerSessionId!, scope.kind, session);
    return { runId, ticket };
  }

  // Name the log file, mint a ticket, trigger /execute — routed to the engine for this session's kind. On
  // engine failure mark the run FAILED immediately AND clear activeKey. For a DOCTOR run, the per-session
  // workspace + doctor-context.json + scoped token are prepared BEFORE execute() and the workspace path is
  // injected as PLANT_DOCTOR_SESSION_WORKSPACE via the per-run env (Task-2 seam).
  private async launch(
    runId: string,
    provider: AgentProvider,
    input: TurnInput,
    resumeSessionId: string | null,
    kind: SessionKind,
    session: { id: string; plantId?: string | null; ownerId?: string | null },
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
          plantId: session.plantId!,
          ownerId: session.ownerId!,
          userId: ownerUser.id,
          username: ownerUser.username,
        });
        perRunEnv = { [WORKSPACE_ENV]: workspaceDir };
      }
      const ticket = await this.tickets.mint(runId);
      await this.engines.engineFor(kind).execute(
        input.command
          ? { runId, provider, command: input.command, logPath, resumeSessionId, env: perRunEnv }
          : { runId, provider, prompt: input.prompt, logPath, resumeSessionId, env: perRunEnv },
      );
      return ticket;
    } catch (err) {
      await this.prisma.knowledgeChatRun.updateMany({
        where: { id: runId, status: { in: [...ACTIVE] } },
        data: { status: 'FAILED', finishedAt: new Date(), error: `Launch failed: ${(err as Error).message}`, activeKey: null },
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
