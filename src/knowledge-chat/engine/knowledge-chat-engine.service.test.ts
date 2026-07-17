import { describe, expect, it } from 'vitest';
import { KnowledgeChatEngineService } from './knowledge-chat-engine.service.js';
import type { EngineParams } from './engine-params.js';

const baseEnv = {
  WEB_ORIGIN: 'http://localhost:8001',
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000,
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CODEX_BIN: 'codex',
  KNOWLEDGE_CHAT_CODEX_SANDBOX: 'danger-full-access',
} as any;

// A DISABLED engine instance — the per-engine facts now live in params, not env.
const params: EngineParams = {
  kind: 'KNOWLEDGE',
  enabled: false,
  cwd: '/tmp/ke',
  port: 8010,
  secret: 's'.repeat(16),
  logDir: '/tmp/knowledge-chat-test-logs',
  stateDir: '/tmp/knowledge-chat-test-state',
};

describe('KnowledgeChatEngineService (disabled)', () => {
  it('onModuleInit does nothing when the engine is disabled', async () => {
    const svc = new KnowledgeChatEngineService(params, baseEnv, {} as any);
    await svc.onModuleInit();
    expect(svc.isRunning).toBe(false);
  });

  it('exposes its logDir from params (the registry roots run logs under the right engine)', () => {
    const svc = new KnowledgeChatEngineService(params, baseEnv, {} as any);
    expect(svc.logDir).toBe('/tmp/knowledge-chat-test-logs');
  });

  it('execute() throws a clear error when the engine is not running', async () => {
    const svc = new KnowledgeChatEngineService(params, baseEnv, {} as any);
    await svc.onModuleInit();
    await expect(
      svc.execute({ runId: 'r1', provider: 'claude', prompt: 'hi', logPath: '/tmp/r1.ndjson', resumeSessionId: null }),
    ).rejects.toThrow(/engine is not running/i);
  });

  // A disabled engine offers NO agent — the picker must render "none available" rather than a provider
  // it would then refuse to run.
  it('providerStatus() reports no agents when the engine is not running', async () => {
    const svc = new KnowledgeChatEngineService(params, baseEnv, {} as any);
    await svc.onModuleInit();
    expect(await svc.providerStatus()).toEqual([]);
  });
});
