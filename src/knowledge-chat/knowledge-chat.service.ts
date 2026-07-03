import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';

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
  private async insertActiveRun(sessionId: string, prompt: string): Promise<string> {
    await this.reconcileStaleActive(sessionId);
    try {
      const run = await this.prisma.knowledgeChatRun.create({
        data: { sessionId, prompt, status: 'QUEUED', activeKey: ACTIVE_KEY },
      });
      return run.id;
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
      claudeSessionId: s.claudeSessionId,
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
      claudeSessionId: session.claudeSessionId,
      turns: session.runs.map((r) => ({
        runId: r.id,
        prompt: r.prompt,
        status: r.status,
        isActive: (ACTIVE as readonly string[]).includes(r.status),
        logUrl: `/knowledge-chat/runs/${r.id}/log`,
      })),
    };
  }

  async createSession(prompt: string): Promise<{ sessionId: string; runId: string; ticket: string }> {
    const actor = this.owner.currentActor();
    const title = prompt.slice(0, 160);
    // Fresh session → no prior active run, so the atomic insert never conflicts here.
    const session = await this.prisma.knowledgeChatSession.create({
      data: { title, createdByUserId: actor?.userId ?? null },
    });
    const runId = await this.insertActiveRun(session.id, prompt);
    const ticket = await this.launch(runId, prompt, null);
    return { sessionId: session.id, runId, ticket };
  }

  async resume(sessionId: string, prompt: string): Promise<{ runId: string; ticket: string }> {
    const session = await this.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException(`Unknown session: ${sessionId}`);
    // Invariant: resumable only once the first run produced Claude's UUID. Spec §4 promises 422.
    if (!session.claudeSessionId) {
      throw new UnprocessableEntityException('Session is not resumable yet (no Claude session id)');
    }
    // Atomic single-active-run claim (reconcile stale → insert; P2002 → 409).
    const runId = await this.insertActiveRun(sessionId, prompt);
    const ticket = await this.launch(runId, prompt, session.claudeSessionId);
    return { runId, ticket };
  }

  // Allocate the log file (create/truncate), mint a ticket, trigger /execute. On engine failure mark
  // the run FAILED immediately AND clear activeKey (never leave it stuck QUEUED / holding the slot).
  private async launch(runId: string, prompt: string, resumeSessionId: string | null): Promise<string> {
    const logPath = this.logPath(runId);
    // The ENTIRE launch is guarded: any failure — log-dir mkdir, file truncate, ticket mint, or the
    // /execute call — must mark the run FAILED and clear activeKey, so a launch error never leaves the
    // run stuck QUEUED holding the session's single-active slot (which would 409 resume/delete until
    // the stale window elapses). Own the write precondition too: ensure the host-owned log dir exists
    // (idempotent) rather than depend on the engine's onModuleInit having run first.
    try {
      await mkdir(this.env.KNOWLEDGE_CHAT_LOG_DIR, { recursive: true });
      await writeFile(logPath, ''); // host creates/truncates; claude fills it via the engine's redirect
      const ticket = await this.tickets.mint(runId);
      await this.engine.execute({ runId, prompt, logPath, resumeSessionId });
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
