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
        deleteMany: vi.fn(async () => ({ count: 1 })),
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

    // Cancel happens strictly before the sweep phase.
    expect(order).toEqual(['cancelRun:run-active', 'sweep:sess-1']);

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
    };
    const chat = { cancelRun: vi.fn(async () => {}) };
    const runContext = { sweep: vi.fn(async () => { throw new Error('disk gone'); }) };
    const engines = { logDirFor: () => logDir };

    const service = new DoctorSessionCleanupService(prisma as any, chat as any, runContext as any, engines as any);

    await expect(service.purgeForPlant('plant-2')).rejects.toThrow('disk gone');

    // Rows must stay intact — deleting them here would orphan whatever the sweep failed to clean up.
    expect(prisma.knowledgeChatSession.deleteMany).not.toHaveBeenCalled();
  });
});
