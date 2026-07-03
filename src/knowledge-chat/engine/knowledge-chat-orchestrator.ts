import { Inject, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { Orchestrator, ActiveRun } from '@retaxmaster/claude-realtime-server';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { KnowledgeChatTicketService } from './knowledge-chat-ticket.service.js';

const ACTIVE = ['QUEUED', 'RUNNING'] as const;

// The four seams the embedded engine uses to reach the host — implemented in-process against Prisma
// (retaxmaster's Node↔Laravel HTTP callback layer disappears). No network, no retry: direct DB writes.
@Injectable()
export class KnowledgeChatOrchestrator implements Orchestrator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: KnowledgeChatTicketService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  validateTicket(ticket: string): Promise<{ runId: string } | null> {
    return this.tickets.consume(ticket);
  }

  // Called TWICE per run (spec §3.2): first with sessionId=null at spawn, then with the real UUID
  // once it appears in the stream. Idempotent — stamps startedAt/claudeSessionId only the first time,
  // and only touches a run that is still active (a late call never resurrects a terminal run).
  async runStarted(runId: string, info: { pid: number; procStartTime: string; sessionId: string | null }): Promise<void> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId } });
    if (!run) return;
    await this.prisma.knowledgeChatRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE] } },
      data: {
        status: 'RUNNING',
        pid: info.pid,
        procStartTime: info.procStartTime,
        startedAt: run.startedAt ?? new Date(), // idempotent: keep the first wall-clock start
      },
    });
    if (info.sessionId) {
      // Capture the born-with-it UUID exactly once (claudeSessionId null → set). A late/different
      // uuid never clobbers because the where-clause no longer matches once it is set.
      await this.prisma.knowledgeChatSession.updateMany({
        where: { id: run.sessionId, claudeSessionId: null },
        data: { claudeSessionId: info.sessionId },
      });
    }
  }

  // Single-winner terminal claim. status: stopped→CANCELLED; exit 0→SUCCEEDED; else FAILED.
  // The atomic updateMany over active statuses means a competing finalizer (engine `done` vs a boot
  // reconcile) elects exactly one — 0 rows affected → someone already finalized → bail. Clearing
  // `activeKey` to null is what frees the session's single-active-run slot (the @@unique constraint).
  async runFinished(runId: string, info: { exitCode: number; stopped: boolean; stderrTail: string | null }): Promise<void> {
    const status = info.stopped ? 'CANCELLED' : info.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
    await this.prisma.knowledgeChatRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE] } },
      data: {
        status,
        exitCode: info.exitCode,
        pid: null,
        finishedAt: new Date(),
        error: status === 'FAILED' ? (info.stderrTail?.slice(0, 1000) ?? null) : null,
        activeKey: null, // terminal → release the unique active slot
      },
    });
  }

  // Boot re-adoption: still-RUNNING children survive a NestJS restart (spawned under setsid). Return
  // only rows with the identity the engine needs (pid/procStartTime/startedAt); a QUEUED row has no
  // pid so it is naturally excluded. startedAtMs re-arms the ORIGINAL deadline (never Date.now()).
  async activeRuns(): Promise<ActiveRun[]> {
    const runs = await this.prisma.knowledgeChatRun.findMany({
      where: { status: 'RUNNING', pid: { not: null }, procStartTime: { not: null }, startedAt: { not: null } },
      include: { session: true },
    });
    return runs.map((r) => ({
      runId: r.id,
      logPath: join(this.env.KNOWLEDGE_CHAT_LOG_DIR, `${r.id}.ndjson`),
      pid: r.pid!,
      procStartTime: r.procStartTime!,
      startedAtMs: r.startedAt!.getTime(),
      sessionId: r.session.claudeSessionId,
    }));
  }
}
