import { describe, expect, it } from 'vitest';
import { buildEngineConfig, KNOWLEDGE_ENGINE_CLAUDE_ARGS } from './knowledge-chat-engine.config.js';

const env = {
  KNOWLEDGE_CHAT_ENGINE_PORT: 8010,
  KNOWLEDGE_CHAT_ENGINE_SECRET: 'secret-value',
  WEB_ORIGIN: 'http://localhost:8001',
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000,
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000,
  KNOWLEDGE_CHAT_LOG_DIR: '/var/knowledge-chat/logs',
  KNOWLEDGE_CHAT_STATE_DIR: '/var/knowledge-chat/state',
  KNOWLEDGE_ENGINE_CWD: '/isolated/knowledge-engine',
  CLAUDE_BIN: 'claude',
  CODEX_BIN: 'codex',
  KNOWLEDGE_CHAT_CODEX_SANDBOX: 'danger-full-access',
} as any;

// The own-run locator seam: it tells the engine WHICH runs a conversation is made of, so a reopened chat
// is rebuilt from our own canonical logs.
const locator = { runsForSession: async () => [] };

describe('buildEngineConfig', () => {
  it('maps env + orchestrator to the createServer config (127.0.0.1, cors, timeouts)', () => {
    const orchestrator = {} as any;
    const cfg = buildEngineConfig(env, orchestrator, locator);
    expect(cfg.port).toBe(8010);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.secret).toBe('secret-value');
    expect(cfg.corsOrigins).toEqual(['http://localhost:8001']);
    expect(cfg.timeouts).toEqual({ runMs: 1_800_000, bufferMs: 120_000 });
    expect(cfg.orchestrator).toBe(orchestrator);
  });

  // agents-realtime 1.0.0: the single `claude:` launch config became a REGISTRY. An agent missing from it
  // cannot be run at all, so "we offer both" is a claim worth asserting rather than assuming.
  it('registers BOTH agents, each rooted in the isolated knowledge-engine checkout', () => {
    const cfg = buildEngineConfig(env, {} as any, locator);
    expect(cfg.providers.claude).toEqual({
      cwd: '/isolated/knowledge-engine',
      bin: 'claude',
      args: KNOWLEDGE_ENGINE_CLAUDE_ARGS,
    });
    expect(cfg.providers.codex).toEqual({
      cwd: '/isolated/knowledge-engine',
      bin: 'codex',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      expectedMcpServers: [],
    });
  });

  // Both are REQUIRED by createServer since 1.0.0 — it refuses to construct without them. logRoot is the
  // allow-list a run log must sit under, so it MUST be the very dir the service builds its logPaths from
  // (KNOWLEDGE_CHAT_LOG_DIR); if those two ever diverge, the engine rejects every run's logPath.
  it('passes the durable stateDir and roots run logs in the log dir', () => {
    const cfg = buildEngineConfig(env, {} as any, locator);
    expect(cfg.stateDir).toBe('/var/knowledge-chat/state');
    expect(cfg.logRoot).toBe('/var/knowledge-chat/logs');
    expect(cfg.ownRunLocator).toBe(locator);
  });

  // Nobody is at the keyboard: an approval request would hang the turn forever. This default is
  // load-bearing, not cosmetic.
  it('runs Codex non-interactively, so a turn cannot hang waiting on an approval', () => {
    const cfg = buildEngineConfig(env, {} as any, locator);
    expect(cfg.providers.codex?.approvalPolicy).toBe('never');
  });
});
