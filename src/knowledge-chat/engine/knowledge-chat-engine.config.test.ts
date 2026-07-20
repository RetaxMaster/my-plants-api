import { describe, expect, it } from 'vitest';
import { buildEngineConfig, KNOWLEDGE_ENGINE_CLAUDE_ARGS } from './knowledge-chat-engine.config.js';
import { ATTACHMENT_CAPS, UPLOAD_TTL_MS } from './body-limit.js';
import type { EngineParams } from './engine-params.js';

// Shared knobs only (bins, sandbox, timeouts, CORS) now come from env; the per-engine facts come from params.
const env = {
  WEB_ORIGIN: 'http://localhost:8001',
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000,
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CODEX_BIN: 'codex',
  KNOWLEDGE_CHAT_CODEX_SANDBOX: 'danger-full-access',
} as any;

const knowledgeParams: EngineParams = {
  kind: 'KNOWLEDGE',
  enabled: true,
  cwd: '/isolated/knowledge-engine',
  port: 8010,
  secret: 'secret-value',
  logDir: '/var/knowledge-chat/logs',
  stateDir: '/var/knowledge-chat/state',
  uploadDir: '/var/knowledge-chat/uploads',
};

// The own-run locator seam: it tells the engine WHICH runs a conversation is made of, so a reopened chat
// is rebuilt from our own canonical logs.
const locator = { runsForSession: async () => [] };

/** The knowledge params with any per-test override applied — so a test can vary ONE fact and no more. */
const paramsFixture = (overrides: Partial<EngineParams> = {}): EngineParams => ({ ...knowledgeParams, ...overrides });

describe('buildEngineConfig', () => {
  it('maps params + env + orchestrator to the createServer config (127.0.0.1, cors, timeouts)', () => {
    const orchestrator = {} as any;
    const cfg = buildEngineConfig(knowledgeParams, env, orchestrator, locator);
    expect(cfg.port).toBe(8010);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.secret).toBe('secret-value');
    expect(cfg.corsOrigins).toEqual(['http://localhost:8001']);
    expect(cfg.timeouts).toEqual({ runMs: 1_800_000, bufferMs: 120_000 });
    expect(cfg.orchestrator).toBe(orchestrator);
  });

  // agents-realtime 1.0.0: the single `claude:` launch config became a REGISTRY. An agent missing from it
  // cannot be run at all, so "we offer both" is a claim worth asserting rather than assuming.
  it('registers BOTH agents, each rooted in the engine params cwd', () => {
    const cfg = buildEngineConfig(knowledgeParams, env, {} as any, locator);
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
  // allow-list a run log must sit under, so it MUST be the very dir the service builds its logPaths from;
  // if those two ever diverge, the engine rejects every run's logPath.
  it('passes the durable stateDir and roots run logs in the log dir', () => {
    const cfg = buildEngineConfig(knowledgeParams, env, {} as any, locator);
    expect(cfg.stateDir).toBe('/var/knowledge-chat/state');
    expect(cfg.logRoot).toBe('/var/knowledge-chat/logs');
    expect(cfg.ownRunLocator).toBe(locator);
  });

  // Nobody is at the keyboard: an approval request would hang the turn forever. This default is
  // load-bearing, not cosmetic.
  it('runs Codex non-interactively, so a turn cannot hang waiting on an approval', () => {
    const cfg = buildEngineConfig(knowledgeParams, env, {} as any, locator);
    expect(cfg.providers.codex?.approvalPolicy).toBe('never');
  });

  // The whole point of the param seam: a SECOND set of params (the doctor engine) bakes a DIFFERENT
  // cwd/port/log/state into the same builder — reuse-not-fork (Spec 3 §2).
  it('bakes the engine params it is given (a DOCTOR engine), not env directly', () => {
    const doctorParams: EngineParams = {
      kind: 'DOCTOR',
      enabled: true,
      cwd: '/srv/doctor',
      port: 8400,
      secret: 's'.repeat(16),
      logDir: '/var/doc-logs',
      stateDir: '/var/doc-state',
      uploadDir: '/var/doc-uploads',
    };
    const cfg = buildEngineConfig(doctorParams, env, {} as any, locator);
    expect(cfg.port).toBe(8400);
    expect(cfg.secret).toBe('s'.repeat(16));
    expect(cfg.logRoot).toBe('/var/doc-logs');
    expect(cfg.stateDir).toBe('/var/doc-state');
    expect(cfg.providers.claude?.cwd).toBe('/srv/doctor');
    expect(cfg.providers.codex?.cwd).toBe('/srv/doctor');
  });
});

describe('attachment configuration (spec §4.2)', () => {
  it('passes the SINGLE cap declaration through to the engine, never a second copy', () => {
    const config = buildEngineConfig(paramsFixture({ uploadDir: '/tmp/uploads-x' }), env, {} as any, locator);

    expect(config.uploadRoot).toBe('/tmp/uploads-x');
    expect(config.uploadMaxCount).toBe(ATTACHMENT_CAPS.maxCount);
    expect(config.uploadMaxFileBytes).toBe(ATTACHMENT_CAPS.maxFileBytes);
    expect(config.uploadMaxTotalBytes).toBe(ATTACHMENT_CAPS.maxTotalBytes);
    expect(config.uploadTtlMs).toBe(UPLOAD_TTL_MS);
  });

  it('leaves bodyLimitBytes at the package default so construction VALIDATES it against our caps', () => {
    // The engine's own limit is a fixed 32 MiB that the package validates against the configured caps and
    // rejects at construction if it does not cover them. That construction-time throw is the desired
    // failure direction, and the reason we do not need to match its arithmetic exactly.
    const config = buildEngineConfig(paramsFixture({ uploadDir: '/tmp/uploads-x' }), env, {} as any, locator);
    expect(config.bodyLimitBytes).toBeUndefined();
  });

  it('uses a per-engine upload root, so the two engines never share one', () => {
    const ke = buildEngineConfig(paramsFixture({ uploadDir: '/tmp/ke-up' }), env, {} as any, locator);
    const pd = buildEngineConfig(paramsFixture({ uploadDir: '/tmp/pd-up' }), env, {} as any, locator);
    expect(ke.uploadRoot).not.toBe(pd.uploadRoot);
  });
});
