import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorSessionCleanupService } from './doctor-session-cleanup.service.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeLogDir() {
  const dir = await mkdtemp(join(tmpdir(), 'doctor-log-'));
  dirs.push(dir);
  return dir;
}

describe('DoctorSessionCleanupService.purgeForPlant', () => {
  it('cancels active runs BEFORE sweeping, sweeps every session, then deletes rows LAST', async () => {
    const logDir = await makeLogDir();
    const activeRun = { id: 'run-active', status: 'RUNNING' };
    const terminalRun = { id: 'run-terminal', status: 'SUCCEEDED' };
    // Seed the run logs so we can also assert they get swept off disk (best-effort, but worth checking).
    await writeFile(join(logDir, `${activeRun.id}.ndjson`), '{}');
    await writeFile(join(logDir, `${terminalRun.id}.ndjson`), '{}');

    const session = { id: 'sess-1', runs: [activeRun, terminalRun] };
    const order: string[] = [];

    const prisma = {
      knowledgeChatSession: {
        findMany: vi.fn(async () => [session]),
        deleteMany: vi.fn(async () => { order.push('deleteSessions'); return { count: 1 }; }),
      },
      // Recorded into `order`, not stubbed to a bare count: the point of the expiry is WHEN it happens
      // relative to the delete, and a `() => ({ count: 0 })` stub cannot express that.
      doctorWriteProposal: {
        updateMany: vi.fn(async (_a: { where: unknown; data: unknown }) => {
          order.push('expireProposals');
          return { count: 1 };
        }),
      },
    };
    const chat = {
      cancelRun: vi.fn(async (runId: string) => {
        order.push(`cancelRun:${runId}`);
      }),
    };
    const runContext = {
      sweep: vi.fn(async (sessionId: string) => {
        order.push(`sweep:${sessionId}`);
      }),
    };
    const engines = { logDirFor: () => logDir };

    const service = new DoctorSessionCleanupService(prisma as any, chat as any, runContext as any, engines as any);

    await service.purgeForPlant('plant-1');

    expect(prisma.knowledgeChatSession.findMany).toHaveBeenCalledWith({
      where: { kind: 'DOCTOR', plantId: 'plant-1' },
      include: { runs: true },
    });

    // Only the ACTIVE run is cancelled — the terminal one is left alone.
    expect(chat.cancelRun).toHaveBeenCalledTimes(1);
    expect(chat.cancelRun).toHaveBeenCalledWith('run-active');

    expect(runContext.sweep).toHaveBeenCalledWith('sess-1');

    // Cancel happens strictly before the sweep phase, and the pending proposals are expired BEFORE the
    // session rows are deleted (spec 5.8).
    expect(order).toEqual(['cancelRun:run-active', 'sweep:sess-1', 'expireProposals', 'deleteSessions']);

    // Scoped to exactly the sessions being retired, and `pendingKey` nulled — an EXPIRED row that kept
    // pendingKey='PENDING' would permanently occupy that session's slot in the null-exempt unique index.
    expect(prisma.doctorWriteProposal.updateMany).toHaveBeenCalledWith({
      where: { sessionId: { in: ['sess-1'] }, status: 'PENDING' },
      data: expect.objectContaining({ status: 'EXPIRED', pendingKey: null, resolvedByUserId: null }),
    });

    // The run logs are removed as part of the FS sweep.
    await expect(stat(join(logDir, `${activeRun.id}.ndjson`))).rejects.toThrow();
    await expect(stat(join(logDir, `${terminalRun.id}.ndjson`))).rejects.toThrow();

    expect(prisma.knowledgeChatSession.deleteMany).toHaveBeenCalledWith({
      where: { kind: 'DOCTOR', plantId: 'plant-1' },
    });
  });

  it('aborts BEFORE deleting rows if the FS sweep fails (nothing left orphaned, retryable)', async () => {
    const logDir = await makeLogDir();
    const session = { id: 'sess-2', runs: [{ id: 'run-1', status: 'RUNNING' }] };

    const prisma = {
      knowledgeChatSession: {
        findMany: vi.fn(async () => [session]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const chat = { cancelRun: vi.fn(async () => {}) };
    const runContext = { sweep: vi.fn(async () => { throw new Error('disk gone'); }) };
    const engines = { logDirFor: () => logDir };

    const service = new DoctorSessionCleanupService(prisma as any, chat as any, runContext as any, engines as any);

    await expect(service.purgeForPlant('plant-2')).rejects.toThrow('disk gone');

    // Rows must stay intact — deleting them here would orphan whatever the sweep failed to clean up.
    expect(prisma.knowledgeChatSession.deleteMany).not.toHaveBeenCalled();
    // ...and nothing was expired either: the purge aborted, so the session is still live and its pending
    // proposal is still legitimately the owner's to resolve.
    expect(prisma.doctorWriteProposal.updateMany).not.toHaveBeenCalled();
  });

  it('expires nothing when the plant has no doctor sessions (never an unscoped updateMany)', async () => {
    // An `in: []` would be harmless, but an updateMany that lost its scope entirely would expire every
    // pending proposal in the table. Skipping the call when there is nothing to retire makes that
    // impossible rather than merely unlikely.
    const prisma = {
      knowledgeChatSession: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
      doctorWriteProposal: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const service = new DoctorSessionCleanupService(
      prisma as any,
      { cancelRun: vi.fn() } as any,
      { sweep: vi.fn() } as any,
      { logDirFor: () => tmpdir() } as any,
    );
    await service.purgeForPlant('plant-3');
    expect(prisma.doctorWriteProposal.updateMany).not.toHaveBeenCalled();
  });
});
