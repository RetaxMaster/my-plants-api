import type {
  CodexProviderConfig,
  CreateServerConfig,
  Orchestrator,
  OwnRunLocator,
} from '@retaxmaster/agents-realtime-server';
import type { Env } from '../../config/env.js';

// Non-interactive, stream-json NDJSON — the Claude ADAPTER parses exactly this shape and translates it
// into canonical AgentEvents. `-p` reads the prompt from stdin (fed by the runner); --verbose is
// required for --output-format=stream-json.
export const KNOWLEDGE_ENGINE_CLAUDE_ARGS = [
  '-p',
  '--verbose',
  '--dangerously-skip-permissions',
  '--output-format=stream-json',
  '--include-partial-messages',
];

// Pure mapping from typed env + the Prisma orchestrator to the package's createServer config. Kept
// separate from the lifecycle service so it is unit-testable without binding a port.
//
// Since agents-realtime 1.0.0 the engine is provider-NEUTRAL: it no longer spawns `claude` itself, it
// spawns a runner that drives the selected provider through an adapter and writes canonical AgentEvents.
// Hence the `providers` registry below (which REPLACED the single `claude:` field) — a provider absent
// from it cannot be run at all. We register BOTH agents; whether either is actually usable is decided at
// runtime by the engine's availability probes (/provider-status), not here.
export function buildEngineConfig(
  env: Env,
  orchestrator: Orchestrator,
  ownRunLocator: OwnRunLocator,
): CreateServerConfig {
  const codex: CodexProviderConfig = {
    cwd: env.KNOWLEDGE_ENGINE_CWD,
    bin: env.CODEX_BIN,
    // See env.ts: full access is the PARITY choice with Claude's --dangerously-skip-permissions, and
    // `workspace-write` would cut the network the research engine depends on.
    sandbox: env.KNOWLEDGE_CHAT_CODEX_SANDBOX,
    // Non-interactive by construction: nobody is at the keyboard to approve anything, and the adapter
    // answers every approval request fail-closed. Asking would just hang the turn forever.
    approvalPolicy: 'never',
    // The knowledge engine drives no MCP servers in its isolated checkout — assert none, so a run does
    // not sit on the MCP-ready barrier waiting for a server that will never come up.
    expectedMcpServers: [],
  };

  return {
    port: env.KNOWLEDGE_CHAT_ENGINE_PORT,
    bindHost: '127.0.0.1',
    secret: env.KNOWLEDGE_CHAT_ENGINE_SECRET,
    // Default secretHeader is now X-Agents-RT-Secret (renamed from X-Claude-RT-Secret in 1.0.0); the
    // NestJS side sends that header on the localhost /execute call.
    corsOrigins: [env.WEB_ORIGIN],
    timeouts: { runMs: env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS, bufferMs: env.KNOWLEDGE_CHAT_RUN_BUFFER_MS },
    orchestrator,
    providers: {
      claude: { cwd: env.KNOWLEDGE_ENGINE_CWD, bin: env.CLAUDE_BIN, args: KNOWLEDGE_ENGINE_CLAUDE_ARGS },
      codex,
    },
    // REQUIRED since 1.0.0. stateDir holds the durable runId→logPath index (what makes a run survive an
    // API restart); logRoot is the allow-list of directories a run log may live in — the engine REJECTS
    // a logPath outside it, so it must contain the dir knowledge-chat.service.ts builds its paths from.
    stateDir: env.KNOWLEDGE_CHAT_STATE_DIR,
    logRoot: env.KNOWLEDGE_CHAT_LOG_DIR,
    // Lets the engine recognize the runs WE executed for a session, so reopening a conversation rebuilds
    // it from our OWN canonical logs (rich tool cards + diffs) instead of a poorer native re-read.
    ownRunLocator,
    // onRun intentionally omitted: no system-prompt injection — the knowledge-engine's own CLAUDE.md /
    // AGENTS.md steers whichever agent runs.
  };
}
