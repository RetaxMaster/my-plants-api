import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorRunContextService } from './doctor-run-context.service.js';

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'doctor-run-ctx-'));
  roots.push(root);
  const env = { PLANT_DOCTOR_WORKSPACE_ROOT: root, PORT: 5501 } as any;
  const auth = { mintDoctorToken: vi.fn(async (_i: Record<string, unknown>) => 'minted-token') };
  const prisma = {
    knowledgeChatSession: {
      findUnique: vi.fn(async (_q: Record<string, unknown>) => ({ skipPermissions: false })),
    },
  };
  const service = new DoctorRunContextService(env, auth as any, prisma as any);
  return { service, auth, prisma, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('DoctorRunContextService.prepareRun', () => {
  it('creates the session workspace dir and writes an atomic doctor-context.json', async () => {
    const { service, auth, root } = await setup();
    const input = {
      sessionId: 'sess-1',
      runId: 'run-1',
      plantId: 'plant-1',
      ownerId: 'owner-1',
      userId: 'user-1',
      username: 'carlos',
    };

    const result = await service.prepareRun(input);

    const workspaceDir = join(root, 'sess-1');
    expect(result).toEqual({ workspaceDir });
    expect((await stat(workspaceDir)).isDirectory()).toBe(true);

    const raw = await readFile(join(workspaceDir, 'doctor-context.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      plantId: 'plant-1',
      ownerId: 'owner-1',
      months: 3,
      apiBaseUrl: 'http://127.0.0.1:5501',
      apiToken: 'minted-token',
      sessionId: 'sess-1',
      runId: 'run-1',
      skipPermissions: false,
    });

    expect(auth.mintDoctorToken).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'carlos',
      ownerId: 'owner-1',
      plantId: 'plant-1',
      sessionId: 'sess-1',
      runId: 'run-1',
    });
  });

  it('mints a token carrying sessionId and runId and mirrors them into doctor-context.json', async () => {
    // Sealing the token to ONE run of ONE session is what stops a doctor token filing a proposal
    // against a DIFFERENT session of the same plant — which matters because that other session may
    // have Skip Permissions on, and the proposal would then be auto-approved with nobody looking.
    const { service, auth, root } = await setup();
    const ctx = await service.prepareRun({
      sessionId: 's1',
      runId: 'r1',
      plantId: 'p1',
      ownerId: 'o1',
      userId: 'u1',
      username: 'retax',
    });
    expect(auth.mintDoctorToken).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', runId: 'r1' }));
    const written = JSON.parse(await readFile(join(ctx.workspaceDir, 'doctor-context.json'), 'utf8'));
    expect(written).toMatchObject({ plantId: 'p1', ownerId: 'o1', sessionId: 's1', runId: 'r1' });
  });

  it('stamps the session-s live skipPermissions into the context, scoped to that session', async () => {
    const { service, prisma, root } = await setup();
    prisma.knowledgeChatSession.findUnique.mockResolvedValueOnce({ skipPermissions: true } as never);
    const ctx = await service.prepareRun({
      sessionId: 's9',
      runId: 'r9',
      plantId: 'p1',
      ownerId: 'o1',
      userId: 'u1',
      username: 'retax',
    });
    const written = JSON.parse(await readFile(join(ctx.workspaceDir, 'doctor-context.json'), 'utf8'));
    expect(written.skipPermissions).toBe(true);
    expect(prisma.knowledgeChatSession.findUnique.mock.calls[0]![0]).toMatchObject({ where: { id: 's9' } });
  });

  it('defaults skipPermissions to false when the session row cannot be read', async () => {
    // Fail CLOSED: an unreadable session must never be treated as "the owner pre-approved everything".
    const { service, prisma } = await setup();
    prisma.knowledgeChatSession.findUnique.mockResolvedValueOnce(null as never);
    const ctx = await service.prepareRun({
      sessionId: 's8',
      runId: 'r8',
      plantId: 'p1',
      ownerId: 'o1',
      userId: 'u1',
      username: 'retax',
    });
    const written = JSON.parse(await readFile(join(ctx.workspaceDir, 'doctor-context.json'), 'utf8'));
    expect(written.skipPermissions).toBe(false);
  });
});

describe('DoctorRunContextService.sweep', () => {
  it('removes the session workspace dir', async () => {
    const { service, root } = await setup();
    const workspaceDir = join(root, 'sess-2');
    await mkdir(workspaceDir, { recursive: true });

    await service.sweep('sess-2');

    await expect(stat(workspaceDir)).rejects.toThrow();
  });

  it('is a no-op when the dir is absent (does not throw)', async () => {
    const { service } = await setup();
    await expect(service.sweep('never-existed')).resolves.toBeUndefined();
  });
});
