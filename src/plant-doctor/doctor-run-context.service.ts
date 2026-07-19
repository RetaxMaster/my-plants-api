import { Inject, Injectable } from '@nestjs/common';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AuthService } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface DoctorRunContext {
  workspaceDir: string; // absolute; passed to the run as PLANT_DOCTOR_SESSION_WORKSPACE (Task-2 seam)
}

// Prepares a DOCTOR run's per-session workspace before launch (Spec 3 §3.3 / §4, agent Spec 1 §6). It mints
// a fresh sealed plant-scoped token, ensures the session workspace dir, and (atomically) writes
// `doctor-context.json` — the single point where the platform hands the agent its plant pin + credentials.
// Fully testable without a CLI spawn.
@Injectable()
export class DoctorRunContextService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  workspaceDir(sessionId: string): string {
    return join(this.env.PLANT_DOCTOR_WORKSPACE_ROOT, sessionId);
  }

  // Called on EVERY doctor run BEFORE launch. Runs within a session are serialized (Spec 3 §2 no-overlap),
  // so no two runs write this at once. Mints a fresh scoped token and (re)writes doctor-context.json.
  async prepareRun(input: {
    sessionId: string;
    runId: string;
    plantId: string;
    ownerId: string;
    userId: string;
    username: string;
  }): Promise<DoctorRunContext> {
    const workspaceDir = this.workspaceDir(input.sessionId);
    await mkdir(workspaceDir, { recursive: true });
    const apiToken = await this.auth.mintDoctorToken({
      userId: input.userId,
      username: input.username,
      ownerId: input.ownerId,
      plantId: input.plantId,
      sessionId: input.sessionId,
      runId: input.runId,
    });
    // Fail CLOSED: an unreadable session is NOT a pre-approving one. `?? false` is the security default,
    // not a convenience — treating a missing row as "skip permissions" would auto-apply writes unseen.
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { id: input.sessionId },
      select: { skipPermissions: true },
    });
    const context = {
      plantId: input.plantId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      runId: input.runId,
      // The API's own localhost port (the doctor runs on the same host). Local default 3000; prod 5501.
      apiBaseUrl: `http://127.0.0.1:${this.env.PORT}`,
      apiToken,
      months: 3, // default context window (agent Spec 1 §4.1), overridable by the agent
      // Stamped so the agent knows the mode without a round trip. It can also READ it via
      // GET .../settings — but it has NO path to write it (spec 6.4).
      skipPermissions: session?.skipPermissions ?? false,
    };
    // Atomic write (temp → rename) so a tool never reads a half-written context. Owner-only mode: the file
    // carries a live token, so it must never be group/other readable.
    const target = join(workspaceDir, 'doctor-context.json');
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(context, null, 2), { mode: 0o600 });
    await rename(tmp, target);
    return { workspaceDir };
  }

  // Sweep a session's workspace (single-session delete + plant-delete cleanup, Spec 3 §3.1). Idempotent.
  async sweep(sessionId: string): Promise<void> {
    await rm(this.workspaceDir(sessionId), { recursive: true, force: true });
  }
}
