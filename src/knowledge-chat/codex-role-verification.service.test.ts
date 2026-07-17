import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRoleVerificationService, maskCodex } from './codex-role-verification.service.js';

const dirs: string[] = [];

async function setup() {
  const docDir = await mkdtemp(join(tmpdir(), 'crv-doctor-'));
  const keDir = await mkdtemp(join(tmpdir(), 'crv-knowledge-'));
  dirs.push(docDir, keDir);
  const env = { PLANT_DOCTOR_STATE_DIR: docDir, KNOWLEDGE_CHAT_STATE_DIR: keDir } as any;
  return { service: new CodexRoleVerificationService(env), docDir, keDir };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('CodexRoleVerificationService', () => {
  it('absent record ⇒ isVerified false for DOCTOR (default-deny)', async () => {
    const { service } = await setup();
    expect(await service.isVerified('DOCTOR')).toBe(false);
  });

  it('absent record ⇒ isVerified false for KNOWLEDGE (default-deny)', async () => {
    const { service } = await setup();
    expect(await service.isVerified('KNOWLEDGE')).toBe(false);
  });

  it('write(kind, true) then isVerified true', async () => {
    const { service } = await setup();
    await service.write('DOCTOR', true);
    expect(await service.isVerified('DOCTOR')).toBe(true);
  });

  it('write(kind, false) then isVerified false — observed on the NEXT read, no new instance', async () => {
    const { service } = await setup();
    await service.write('DOCTOR', true);
    expect(await service.isVerified('DOCTOR')).toBe(true);
    // Flip it, with the SAME instance — the record must be read dynamically, never cached at boot.
    await service.write('DOCTOR', false);
    expect(await service.isVerified('DOCTOR')).toBe(false);
  });

  it('codexRolesVerified missing ⇒ isVerified false', async () => {
    const { service, docDir } = await setup();
    await mkdir(docDir, { recursive: true });
    await writeFile(join(docDir, 'codex-roles-verified.json'), JSON.stringify({}));
    expect(await service.isVerified('DOCTOR')).toBe(false);
  });

  it('codexRolesVerified as the STRING "true" ⇒ isVerified false (strict boolean)', async () => {
    const { service, docDir } = await setup();
    await mkdir(docDir, { recursive: true });
    await writeFile(
      join(docDir, 'codex-roles-verified.json'),
      JSON.stringify({ codexRolesVerified: 'true' }),
    );
    expect(await service.isVerified('DOCTOR')).toBe(false);
  });

  it('garbage JSON ⇒ isVerified false', async () => {
    const { service, docDir } = await setup();
    await mkdir(docDir, { recursive: true });
    await writeFile(join(docDir, 'codex-roles-verified.json'), 'not json{{{');
    expect(await service.isVerified('DOCTOR')).toBe(false);
  });

  it('DOCTOR and KNOWLEDGE keys are independent', async () => {
    const { service } = await setup();
    await service.write('DOCTOR', true);
    expect(await service.isVerified('DOCTOR')).toBe(true);
    expect(await service.isVerified('KNOWLEDGE')).toBe(false);
  });
});

describe('maskCodex', () => {
  const statuses: { provider: string; available: boolean; error?: string | null }[] = [
    { provider: 'codex', available: true },
    { provider: 'claude', available: true },
  ];

  it('verified=true → returns the list unchanged', () => {
    expect(maskCodex(statuses, true)).toEqual(statuses);
  });

  it('verified=false → codex becomes available:false with a non-empty error; others untouched', () => {
    const result = maskCodex(statuses, false);
    const codex = result.find((s) => s.provider === 'codex')!;
    const claude = result.find((s) => s.provider === 'claude')!;
    expect(codex.available).toBe(false);
    expect(typeof codex.error).toBe('string');
    expect(codex.error!.length).toBeGreaterThan(0);
    expect(claude).toEqual({ provider: 'claude', available: true });
  });

  it('verified=false preserves an existing error message instead of overwriting it', () => {
    const withError = [{ provider: 'codex', available: false, error: 'custom reason' }];
    const result = maskCodex(withError, false);
    expect(result[0].error).toBe('custom reason');
  });
});
