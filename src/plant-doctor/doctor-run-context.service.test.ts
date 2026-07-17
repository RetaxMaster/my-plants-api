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
  const auth = { mintDoctorToken: vi.fn(async () => 'minted-token') };
  const service = new DoctorRunContextService(env, auth as any);
  return { service, auth, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('DoctorRunContextService.prepareRun', () => {
  it('creates the session workspace dir and writes an atomic doctor-context.json', async () => {
    const { service, auth, root } = await setup();
    const input = { sessionId: 'sess-1', plantId: 'plant-1', ownerId: 'owner-1', userId: 'user-1', username: 'carlos' };

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
    });

    expect(auth.mintDoctorToken).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'carlos',
      ownerId: 'owner-1',
      plantId: 'plant-1',
    });
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
