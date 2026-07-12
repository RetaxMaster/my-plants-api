import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AgentProvider, SessionHistory } from '@retaxmaster/agents-realtime-protocol';
import { SessionNotFoundError } from '@retaxmaster/agents-realtime-server';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';

// The engine's typed "there is nothing left to read" errors. Classified against the package's own error
// classes rather than by matching message text, so a reworded message cannot silently turn a real outage
// into a fake "empty transcript".
// ONLY this one: the agent no longer holds the session on disk (it purged it, or the conversation predates
// this engine). That is a real, expected, unrecoverable loss of the VIEW — not of the conversation.
//
// Deliberately NOT degraded, because each would be a defect wearing a lost-transcript costume:
//   - InvalidSessionIdError — our DB holds an id the agent's adapter refuses outright: data corruption.
//   - OwnRunLogUnavailableError — since runsForSession() became all-or-nothing we never claim a run the
//     engine cannot resolve, so this can now only mean the index changed under us. A real bug.
// Both stay loud (500). Dressing an outage up as "your old chat is empty" is how a defect hides in plain
// sight — the exact failure this classification exists to prevent.
function isHistoryGone(err: unknown): boolean {
  return err instanceof SessionNotFoundError;
}

// Our history envelope: the package's canonical SessionHistory, plus the one fact only WE can report —
// that the agent itself no longer holds this session, so the conversation is not merely unreadable, it is
// un-continuable.
//
// KNOWN LIMIT, stated rather than hidden: this flag is SOUND but not EXHAUSTIVE. It can only be raised when
// the restore actually consulted the agent's own transcript and was told the session is gone. A conversation
// rebuilt from OUR canonical logs never asks the agent anything, so an agent that has since purged its
// session looks identical to one that has not. We accept that: making it exhaustive would mean probing the
// agent on every chat open — for Codex, spawning an app-server process each time — on the hot path, to
// pre-empt a failure that already surfaces loudly and harmlessly (the resume run fails and the UI shows the
// agent's error; nothing is corrupted and no history is lost). So: when the flag is true, we KNOW; when it
// is absent, we simply do not claim to know.
export type KnowledgeChatHistory = SessionHistory & { agentSessionMissing?: boolean };

const ACTIVE = ['QUEUED', 'RUNNING'] as const;
// The value in `activeKey` while a run is non-terminal. Cleared to null on every terminal transition
// (here on launch failure; in the orchestrator on runFinished). The @@unique([sessionId, activeKey])
// constraint then permits at most ONE active run per session (null is exempt in MySQL/MariaDB).
const ACTIVE_KEY = 'ACTIVE';
type KnowledgeChatRunRow = { id: string; status: string; startedAt: Date | null; createdAt: Date };

@Injectable()
export class KnowledgeChatService {
  private readonly logger = new Logger(KnowledgeChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: KnowledgeChatEngineService,
    private readonly tickets: KnowledgeChatTicketService,
    private readonly owner: OwnerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private logPath(runId: string): string {
    return join(this.env.KNOWLEDGE_CHAT_LOG_DIR, `${runId}.ndjson`);
  }

  // A run is "stale" once it is past the engine's own reap window (timeout + buffer) with no terminal
  // callback — i.e. its process is (almost certainly) gone. Time-based, anchored on startedAt (or
  // createdAt for a never-started QUEUED orphan). Mirrors retaxmaster's isStale.
  private isStale(run: KnowledgeChatRunRow): boolean {
    const anchor = (run.startedAt ?? run.createdAt).getTime();
    return Date.now() - anchor > this.env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS + this.env.KNOWLEDGE_CHAT_RUN_BUFFER_MS;
  }

  // Free the unique slot for any STALE active run (dead process, no terminal callback) so it doesn't
  // block the session forever. A genuinely live run is left alone — the atomic insert below will 409.
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
  // activeKey='ACTIVE'. Concurrency is decided by the DB unique constraint — a racing second insert
  // hits P2002 and becomes a 409. A read-then-check could not prevent the double-insert.
  // `onlyWhileUnsealed` (the RETRY of an opening turn): re-point the conversation at `provider`, but only
  // while it still has no agent session — and do it in the SAME transaction that creates the run and hands
  // it the seal claim. Returns null if the conversation got sealed in the meantime (caller resumes instead).
  private async insertActiveRun(
    sessionId: string,
    provider: AgentProvider,
    prompt: string,
    opts?: { onlyWhileUnsealed?: boolean },
  ): Promise<string | null> {
    await this.reconcileStaleActive(sessionId);
    try {
      // ONE transaction. Re-pointing the agent, creating the run, and handing that run the SEAL CLAIM
      // (`pendingRunId`) are all halves of a single fact — "this run is now the conversation's attempt" —
      // and they must be decided against the same row state, or the race simply moves into the gap between
      // them (which is exactly where it was: the abandoned run's late `session.started` still matched the
      // OLD claim after we had already re-pointed the provider, sealing the conversation to the agent the
      // user had just walked away from, while its replacement was launching).
      //
      // The conditional UPDATE below takes the session row's write lock. A concurrent seal targets that same
      // row, so it must WAIT for this transaction and then re-evaluate its WHERE clause against the
      // committed state — by which time `pendingRunId` names the new run and the stale seal cannot match.
      // The two now contend for one row, and exactly one wins.
      return await this.prisma.$transaction(async (tx) => {
        if (opts?.onlyWhileUnsealed) {
          const { count } = await tx.knowledgeChatSession.updateMany({
            where: { id: sessionId, providerSessionId: null },
            data: { provider },
          });
          if (count === 0) return null; // sealed in the gap → this is no longer a retry
        }
        const run = await tx.knowledgeChatRun.create({
          // The agent is recorded ON the run: it is the only thing that knows which agent produced the
          // session id it later reports, and the orchestrator seals `provider` + `providerSessionId` from
          // that same row, atomically, so the pair can never describe two different agents.
          data: { sessionId, provider, prompt, status: 'QUEUED', activeKey: ACTIVE_KEY },
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

  async listSessions() {
    const sessions = await this.prisma.knowledgeChatSession.findMany({
      orderBy: { createdAt: 'desc' },
      include: { runs: { orderBy: { createdAt: 'desc' } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      provider: s.provider,
      providerSessionId: s.providerSessionId,
      title: s.title,
      status: s.runs[0]?.status ?? null,
      turns: s.runs.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  async getSession(id: string) {
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { id },
      include: { runs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException(`Unknown session: ${id}`);
    return {
      id: session.id,
      title: session.title,
      // The agent this conversation is locked to — the UI seeds its picker with it (and locks it once
      // providerSessionId exists, i.e. a real agent session was established).
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      turns: session.runs.map((r) => ({
        runId: r.id,
        prompt: r.prompt,
        status: r.status,
        isActive: (ACTIVE as readonly string[]).includes(r.status),
        logUrl: `/knowledge-chat/runs/${r.id}/log`,
      })),
    };
  }

  // The AGENT is chosen here, once, and every later turn of this conversation reuses it: a Claude
  // session and a Codex thread cannot read each other's history, so a conversation is bound to the agent
  // that actually holds its memory.
  async createSession(prompt: string, provider: AgentProvider): Promise<{ sessionId: string; runId: string; ticket: string }> {
    const actor = this.owner.currentActor();
    const title = prompt.slice(0, 160);
    // Fresh session → no prior active run, so the atomic insert never conflicts here.
    const session = await this.prisma.knowledgeChatSession.create({
      data: { title, provider, createdByUserId: actor?.userId ?? null },
    });
    const runId = (await this.insertActiveRun(session.id, provider, prompt))!;
    const ticket = await this.launch(runId, provider, prompt, null);
    return { sessionId: session.id, runId, ticket };
  }

  // Continue a conversation — or RETRY its opening turn if that turn never got an agent off the ground.
  //
  // The provider is committed on PROOF OF A REAL SESSION (an agent session id), not on the mere intent to
  // run one. That distinction is the whole ballgame: a first run that never spawned (the agent was signed
  // out, the binary was missing, the engine refused it at the availability gate) leaves a conversation
  // with NO agent memory behind it. Treating such a conversation as "locked to that agent, permanently
  // un-resumable" traps the user on a broken agent with no way out but deleting the conversation — so
  // while `providerSessionId` is null the opening turn is simply retried, and the caller may name a
  // DIFFERENT agent, because there is no memory for a second agent to contradict.
  //
  // Once an agent session exists, the agent is FINAL: the caller does not get to pick. Resuming a Claude
  // session on Codex would hand an agent a memory it cannot read.
  async resume(
    sessionId: string,
    prompt: string,
    provider?: AgentProvider,
  ): Promise<{ runId: string; ticket: string }> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException(`Unknown session: ${sessionId}`);

    if (!session.providerSessionId) {
      // The opening turn never established an agent session → retry it, on whichever agent is asked for
      // (defaulting to the one originally chosen). Not a resume: there is nothing to resume FROM, so the
      // run starts a FRESH agent session (resumeSessionId = null). The whole claim — re-point the agent,
      // create the run, take the seal — is decided atomically against one row, so an abandoned run's late
      // report cannot slip in between and pin the conversation to the agent being replaced.
      const retryProvider = provider ?? (session.provider as AgentProvider);
      const runId = await this.insertActiveRun(sessionId, retryProvider, prompt, { onlyWhileUnsealed: true });
      if (runId) {
        const ticket = await this.launch(runId, retryProvider, prompt, null);
        return { runId, ticket };
      }
      // Lost the race: an agent session appeared while we were claiming. The conversation now HAS a memory,
      // so it is no longer a retry — continue it, on ITS agent.
      const settled = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      if (!settled?.providerSessionId) throw new NotFoundException(`Unknown session: ${sessionId}`);
      session.provider = settled.provider;
      session.providerSessionId = settled.providerSessionId;
    }

    // Atomic single-active-run claim (reconcile stale → insert; P2002 → 409). Unguarded, so it always
    // returns a run id.
    const sessionProvider = session.provider as AgentProvider;
    const runId = (await this.insertActiveRun(sessionId, sessionProvider, prompt))!;
    const ticket = await this.launch(runId, sessionProvider, prompt, session.providerSessionId!);
    return { runId, ticket };
  }

  // Name the log file, mint a ticket, trigger /execute. On engine failure mark the run FAILED
  // immediately AND clear activeKey (never leave it stuck QUEUED / holding the slot).
  private async launch(
    runId: string,
    provider: AgentProvider,
    prompt: string,
    resumeSessionId: string | null,
  ): Promise<string> {
    const logPath = this.logPath(runId);
    // The ENTIRE launch is guarded: any failure — log-dir mkdir, ticket mint, or the /execute call —
    // must mark the run FAILED and clear activeKey, so a launch error never leaves the run stuck QUEUED
    // holding the session's single-active slot (which would 409 resume/delete until the stale window
    // elapses). Own the log-dir precondition (idempotent) rather than depend on the engine's
    // onModuleInit having run first.
    //
    // We do NOT create the log file. Since agents-realtime 1.0.0 the ENGINE creates it exclusively
    // (O_CREAT|O_EXCL) and writes its header + the user prompt into it; a path that already exists is
    // rejected pre-acceptance, so the old `writeFile(logPath, '')` here would 422 every single run. That
    // exclusivity is also the guard that stops two runs from ever sharing one log — do not reinstate it.
    try {
      await mkdir(this.env.KNOWLEDGE_CHAT_LOG_DIR, { recursive: true });
      const ticket = await this.tickets.mint(runId);
      await this.engine.execute({ runId, provider, prompt, logPath, resumeSessionId });
      return ticket;
    } catch (err) {
      await this.prisma.knowledgeChatRun.updateMany({
        where: { id: runId, status: { in: [...ACTIVE] } },
        data: { status: 'FAILED', finishedAt: new Date(), error: `Launch failed: ${(err as Error).message}`, activeKey: null },
      });
      throw err;
    }
  }

  async deleteSession(id: string): Promise<{ ok: true }> {
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { id },
      include: { runs: true },
    });
    if (!session) throw new NotFoundException(`Unknown session: ${id}`);
    const active = session.runs.find(
      (r) => (ACTIVE as readonly string[]).includes(r.status) && !this.isStale(r),
    );
    if (active) throw new ConflictException('Cannot delete a session with an active run');
    // Best-effort log purge (files are runtime artifacts). Cascade deletes runs + tickets.
    await Promise.all(session.runs.map((r) => rm(this.logPath(r.id), { force: true })));
    await this.prisma.knowledgeChatSession.delete({ where: { id } });
    return { ok: true };
  }

  // The conversation's transcript, as canonical AgentEvents the chat UI can seed straight into its
  // transcript. Sourced from the engine (which rebuilds it from the runs WE executed), never parsed here.
  // A conversation whose first run never established an agent session has no history to load — and never
  // will — so it answers 422 rather than pretending an empty transcript is a successful read.
  async getSessionHistory(id: string): Promise<KnowledgeChatHistory> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException(`Unknown session: ${id}`);
    if (!session.providerSessionId) {
      throw new UnprocessableEntityException('Session has no agent session yet (its first run never started one)');
    }
    const provider = session.provider as AgentProvider;
    try {
      return await this.engine.loadHistory(provider, session.providerSessionId);
    } catch (err) {
      // Degrade ONLY the errors that genuinely mean "this transcript no longer exists to be read":
      // the agent purged its own on-disk session, or this conversation predates the engine's durable run
      // index (a pre-1.0.0 run). For those, an empty transcript is the honest answer — the conversation
      // still exists, is still bound to its agent, and is still resumable; only our VIEW of the past is
      // gone. The agent itself has not forgotten.
      //
      // Everything else — a misconfigured engine, an unreadable directory, a bug in our own locator — is a
      // REAL failure and must stay loud (a 500). Swallowing those would dress an operational outage up as
      // "the user's old chat is empty", which is precisely how a defect hides in plain sight.
      if (!isHistoryGone(err)) throw err;
      this.logger.warn(
        `Knowledge-chat session ${id}: transcript no longer available (${(err as Error).message}) — serving an empty history.`,
      );
      // `agentSessionMissing` is not decoration: SessionNotFoundError means the AGENT no longer holds this
      // session, so continuing the conversation cannot work either — a resume would hand the agent a session
      // id it will reject. Telling the UI lets it say so plainly instead of inviting the user to send a
      // message that is guaranteed to fail with a cryptic agent error.
      return { provider, providerSessionId: session.providerSessionId, turns: [], agentSessionMissing: true };
    }
  }

  async getRunLog(runId: string): Promise<string> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Unknown run: ${runId}`);
    try {
      return await readFile(this.logPath(runId), 'utf8');
    } catch {
      throw new NotFoundException('Transcript log not found');
    }
  }

  async mintSocketTicket(runId: string): Promise<{ ticket: string }> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Unknown run: ${runId}`);
    return { ticket: await this.tickets.mint(runId) };
  }
}
