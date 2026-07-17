import { Inject, Injectable } from '@nestjs/common';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

type Kind = 'KNOWLEDGE' | 'DOCTOR';

// Per-engine `codexRolesVerified` record (Codex-parity Spec 2 §5 / Spec 3 §3.2). Default-DENY:
// absent/unreadable/non-boolean/false ⇒ Codex is OFF for that pipeline. Read DYNAMICALLY per request (never
// cached at boot) so a deploy can flip the running process to fail-closed WITHOUT a restart — closing the
// deploy-window race. Written atomically (temp → rename) by the deploy's re-verify probe. The on-disk
// contract is shared BYTE-FOR-BYTE with the probe writer (Phase 2's verification-record.ts): file
// `<stateDir>/codex-roles-verified.json`, shape `{ "codexRolesVerified": boolean }`, keyed per-engine by
// which state dir (PLANT_DOCTOR_STATE_DIR for the doctor, KNOWLEDGE_CHAT_STATE_DIR for the KE).
@Injectable()
export class CodexRoleVerificationService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private recordPath(kind: Kind): string {
    const stateDir = kind === 'DOCTOR' ? this.env.PLANT_DOCTOR_STATE_DIR : this.env.KNOWLEDGE_CHAT_STATE_DIR;
    return join(stateDir, 'codex-roles-verified.json');
  }

  async isVerified(kind: Kind): Promise<boolean> {
    try {
      const raw = await readFile(this.recordPath(kind), 'utf8');
      return (JSON.parse(raw) as { codexRolesVerified?: unknown })?.codexRolesVerified === true; // strict true
    } catch {
      return false; // absent or unreadable → default-deny
    }
  }

  async write(kind: Kind, verified: boolean): Promise<void> {
    const path = this.recordPath(kind);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify({ codexRolesVerified: verified }));
    await rename(tmp, path);
  }
}

// Fold a Codex-unavailable verdict into the engine's provider-status list, so the picker reports Codex
// UNAVAILABLE while the record is false/absent — the same fact the run-path gate enforces, so the UI and the
// gate cannot disagree. Pure + shared by both controllers (Spec 3 §3.2).
export function maskCodex<T extends { provider: string; available: boolean; error?: string | null }>(
  statuses: T[],
  codexVerified: boolean,
): T[] {
  if (codexVerified) return statuses;
  return statuses.map((s) =>
    s.provider === 'codex'
      ? { ...s, available: false, error: s.error ?? 'Codex roles are not verified for this pipeline.' }
      : s,
  );
}
