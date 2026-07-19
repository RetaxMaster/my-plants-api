import { Injectable } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { KnowledgeChatService } from '../knowledge-chat/knowledge-chat.service.js';
import { ChatEngineRegistry } from '../knowledge-chat/engine/chat-engine-registry.js';
import { DoctorRunContextService } from './doctor-run-context.service.js';
import { ACTIVE_RUN_STATUSES } from '../knowledge-chat/run-status.js';

const ACTIVE = ACTIVE_RUN_STATUSES;

// Orchestrated plant-delete cleanup for DOCTOR sessions (Spec 3 §3.1). Deleting a plant must leave NO
// orphaned session row, workspace dir, engine log, or in-flight run. Ordered so a partial failure never
// orphans FS state whose locating rows are already gone: cancel active runs → sweep FS FIRST → delete rows
// LAST; if the sweep throws, abort BEFORE deleting rows (retryable). Reuses the shared run-cancel + the
// workspace sweep — never re-implements them.
//
// NOTE (2026-07-17): the API exposes NO plant-delete endpoint today, so this has no production caller yet.
// It is the ready orchestrated hook for a future plant-delete flow; meanwhile the DB `onDelete: Cascade`
// on the session→plant relation is the row-half safety net if a plant is ever removed out-of-band.
@Injectable()
export class DoctorSessionCleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: KnowledgeChatService,
    private readonly runContext: DoctorRunContextService,
    private readonly engines: ChatEngineRegistry,
  ) {}

  async purgeForPlant(plantId: string): Promise<void> {
    const sessions = await this.prisma.knowledgeChatSession.findMany({
      where: { kind: 'DOCTOR', plantId },
      include: { runs: true },
    });

    // (1) Cancel/await any active run per session — never yank a row from under a live run.
    for (const s of sessions) {
      for (const r of s.runs.filter((r) => (ACTIVE as readonly string[]).includes(r.status))) {
        await this.chat.cancelRun(r.id);
      }
    }

    // (2) Sweep FS FIRST — workspace dir + each run's log. If ANY sweep throws, it propagates BEFORE we
    // delete rows, so nothing is orphaned and the delete is retryable.
    const doctorLogDir = this.engines.logDirFor('DOCTOR');
    for (const s of sessions) {
      await this.runContext.sweep(s.id);
      await Promise.all(s.runs.map((r) => rm(join(doctorLogDir, `${r.id}.ndjson`), { force: true })));
    }

    // (3) No pending proposal outlives its session's usefulness (spec 5.8). The rows themselves cascade on
    // session delete, so this is not about the end state — it is about the WINDOW. Between here and the
    // delete below a concurrent reader can still see a PENDING proposal for a session that is being torn
    // down, and its owner could approve it. Expiring first closes that window; it also nulls `pendingKey`,
    // without which the null-exempt unique index would keep the slot occupied for that session id.
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length) {
      await this.prisma.doctorWriteProposal.updateMany({
        where: { sessionId: { in: sessionIds }, status: 'PENDING' },
        data: { status: 'EXPIRED', pendingKey: null, resolvedAt: new Date(), resolvedByUserId: null },
      });
    }

    // (4) Delete rows LAST (cascade removes runs/tickets/proposals). Reached only if every sweep succeeded.
    await this.prisma.knowledgeChatSession.deleteMany({ where: { kind: 'DOCTOR', plantId } });
  }
}
