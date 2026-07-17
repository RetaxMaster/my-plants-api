import type { Env } from '../../config/env.js';

// One engine instance's identity + resources. Everything that DIFFERS between the KNOWLEDGE engine and the
// DOCTOR engine lives here; everything SHARED (bins, sandbox, timeouts, CORS) is read from `env` in the
// config builder. This is the seam that lets ONE buildEngineConfig/service/orchestrator serve both engines
// — reuse-not-fork (Plant Doctor Spec 3 §2). `kind` matches Prisma's `ChatSessionKind`.
export interface EngineParams {
  kind: 'KNOWLEDGE' | 'DOCTOR';
  enabled: boolean;
  cwd: string; // the runtime checkout the CLI launches in (loads its CLAUDE.md/.claude/.codex)
  port: number;
  secret: string;
  logDir: string; // logRoot allow-list + where this engine's run logs live (absolute)
  stateDir: string; // durable runId→logPath index + the codexRolesVerified record (absolute)
}

// DI tokens: two engine instances + two orchestrators are provided under these symbols so the registry and
// the service can inject the right one without a class identity collision.
export const KNOWLEDGE_ENGINE = Symbol('KNOWLEDGE_ENGINE');
export const DOCTOR_ENGINE = Symbol('DOCTOR_ENGINE');
export const KNOWLEDGE_ORCHESTRATOR = Symbol('KNOWLEDGE_ORCHESTRATOR');
export const DOCTOR_ORCHESTRATOR = Symbol('DOCTOR_ORCHESTRATOR');

export function knowledgeEngineParams(env: Env): EngineParams {
  return {
    kind: 'KNOWLEDGE',
    enabled: env.KNOWLEDGE_CHAT_ENGINE_ENABLED,
    cwd: env.KNOWLEDGE_ENGINE_CWD,
    port: env.KNOWLEDGE_CHAT_ENGINE_PORT,
    secret: env.KNOWLEDGE_CHAT_ENGINE_SECRET,
    logDir: env.KNOWLEDGE_CHAT_LOG_DIR,
    stateDir: env.KNOWLEDGE_CHAT_STATE_DIR,
  };
}

export function doctorEngineParams(env: Env): EngineParams {
  return {
    kind: 'DOCTOR',
    enabled: env.PLANT_DOCTOR_ENGINE_ENABLED,
    cwd: env.PLANT_DOCTOR_ENGINE_CWD,
    port: env.PLANT_DOCTOR_CHAT_ENGINE_PORT,
    secret: env.PLANT_DOCTOR_CHAT_ENGINE_SECRET,
    logDir: env.PLANT_DOCTOR_LOG_DIR,
    stateDir: env.PLANT_DOCTOR_STATE_DIR,
  };
}
