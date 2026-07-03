import type { CreateServerConfig, Orchestrator } from '@retaxmaster/claude-realtime-server';
import type { Env } from '../../config/env.js';

// Non-interactive, stream-json NDJSON — the engine tails/parses exactly this shape. `-p` reads the
// prompt from stdin (fed by the supervisor); --verbose is required for --output-format=stream-json.
export const KNOWLEDGE_ENGINE_CLAUDE_ARGS = [
  '-p',
  '--verbose',
  '--dangerously-skip-permissions',
  '--output-format=stream-json',
  '--include-partial-messages',
];

// Pure mapping from typed env + the Prisma orchestrator to the package's createServer config. Kept
// separate from the lifecycle service so it is unit-testable without binding a port.
export function buildEngineConfig(env: Env, orchestrator: Orchestrator): CreateServerConfig {
  return {
    port: env.KNOWLEDGE_CHAT_ENGINE_PORT,
    bindHost: '127.0.0.1',
    secret: env.KNOWLEDGE_CHAT_ENGINE_SECRET,
    // Default secretHeader (X-Claude-RT-Secret) is fine; NestJS sends it on the localhost /execute call.
    corsOrigins: [env.WEB_ORIGIN],
    timeouts: { runMs: env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS, bufferMs: env.KNOWLEDGE_CHAT_RUN_BUFFER_MS },
    orchestrator,
    claude: { cwd: env.KNOWLEDGE_ENGINE_CWD, bin: env.CLAUDE_BIN, args: KNOWLEDGE_ENGINE_CLAUDE_ARGS },
    // onRun intentionally omitted: no system-prompt injection — the knowledge-engine's own CLAUDE.md steers.
  };
}
