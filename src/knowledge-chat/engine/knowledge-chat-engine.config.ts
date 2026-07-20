import type {
  CodexProviderConfig,
  CreateServerConfig,
  Orchestrator,
  OwnRunLocator,
} from '@retaxmaster/agents-realtime-server';
import type { Env } from '../../config/env.js';
import type { EngineParams } from './engine-params.js';
import { ATTACHMENT_CAPS, UPLOAD_TTL_MS } from './body-limit.js';

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
// Param-driven since the Plant Doctor (Spec 3 §2): the four per-engine facts (cwd/port/secret/log+state
// dirs) come from `params`, so ONE builder stands up BOTH the KNOWLEDGE engine and the DOCTOR engine; the
// SHARED knobs (bins, sandbox, timeouts, CORS) still come from `env`. A DOCTOR run therefore executes in the
// doctor checkout with its own port/log isolation, without forking this builder.
export function buildEngineConfig(
  params: EngineParams,
  env: Env,
  orchestrator: Orchestrator,
  ownRunLocator: OwnRunLocator,
): CreateServerConfig {
  const codex: CodexProviderConfig = {
    cwd: params.cwd,
    bin: env.CODEX_BIN,
    // See env.ts: full access is the PARITY choice with Claude's --dangerously-skip-permissions, and
    // `workspace-write` would cut the network the research engine depends on.
    sandbox: env.KNOWLEDGE_CHAT_CODEX_SANDBOX,
    // Non-interactive by construction: nobody is at the keyboard to approve anything, and the adapter
    // answers every approval request fail-closed. Asking would just hang the turn forever.
    approvalPolicy: 'never',
    // Neither engine drives MCP servers in its isolated checkout — assert none, so a run does not sit on
    // the MCP-ready barrier waiting for a server that will never come up.
    expectedMcpServers: [],
  };

  return {
    port: params.port,
    bindHost: '127.0.0.1',
    secret: params.secret,
    // Default secretHeader is now X-Agents-RT-Secret (renamed from X-Claude-RT-Secret in 1.0.0); the
    // NestJS side sends that header on the localhost /execute call.
    corsOrigins: [env.WEB_ORIGIN],
    timeouts: { runMs: env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS, bufferMs: env.KNOWLEDGE_CHAT_RUN_BUFFER_MS },
    orchestrator,
    providers: {
      claude: { cwd: params.cwd, bin: env.CLAUDE_BIN, args: KNOWLEDGE_ENGINE_CLAUDE_ARGS },
      codex,
    },
    // REQUIRED since 1.0.0. stateDir holds the durable runId→logPath index (what makes a run survive an
    // API restart); logRoot is the allow-list of directories a run log may live in — the engine REJECTS
    // a logPath outside it, so it must contain the dir knowledge-chat.service.ts builds its paths from.
    stateDir: params.stateDir,
    logRoot: params.logDir,
    // Lets the engine recognize the runs WE executed for a session, so reopening a conversation rebuilds
    // it from our OWN canonical logs (rich tool cards + diffs) instead of a poorer native re-read.
    ownRunLocator,
    // Attachments (spec §4.2). The caps come from the ONE declaration in body-limit.ts, which also derives
    // our Nest body limit — so the API and the engine can never disagree about what is acceptable.
    //
    // `uploadRoot` is per-engine and must EXIST, be owned by the engine's OS user and not be
    // group/other-writable, or createServer() throws (B7). The service creates it with mode 0700 before
    // constructing, so a misconfigured directory fails the deploy loudly rather than at 3am.
    uploadRoot: params.uploadDir,
    uploadMaxCount: ATTACHMENT_CAPS.maxCount,
    uploadMaxFileBytes: ATTACHMENT_CAPS.maxFileBytes,
    uploadMaxTotalBytes: ATTACHMENT_CAPS.maxTotalBytes,
    // How long the AGENT can re-examine an earlier image. The browser is unaffected: a restored attachment
    // renders as a filename and an icon regardless (spec §4.3).
    uploadTtlMs: UPLOAD_TTL_MS,
    // bodyLimitBytes is DELIBERATELY not set. The package default (32 MiB) is validated against the caps
    // above at construction and throws if it does not cover them — which is the failure direction we want.
    //
    // onRun intentionally omitted: no system-prompt injection — each checkout's own CLAUDE.md / AGENTS.md
    // steers whichever agent runs.
  };
}
