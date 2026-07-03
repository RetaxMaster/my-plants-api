import { describe, expect, it } from 'vitest';
import { KnowledgeChatEngineService } from './knowledge-chat-engine.service.js';

const baseEnv = {
  KNOWLEDGE_CHAT_ENGINE_ENABLED: false,
  KNOWLEDGE_CHAT_ENGINE_PORT: 8010,
  KNOWLEDGE_CHAT_ENGINE_SECRET: 's'.repeat(16),
  KNOWLEDGE_CHAT_LOG_DIR: '/tmp/knowledge-chat-test-logs',
  WEB_ORIGIN: 'http://localhost:8001',
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000,
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000,
  KNOWLEDGE_ENGINE_CWD: '/tmp/ke',
  CLAUDE_BIN: 'claude',
} as any;

describe('KnowledgeChatEngineService (disabled)', () => {
  it('onModuleInit does nothing when the engine is disabled', async () => {
    const svc = new KnowledgeChatEngineService(baseEnv, {} as any);
    await svc.onModuleInit();
    expect(svc.isRunning).toBe(false);
  });

  it('execute() throws a clear error when the engine is not running', async () => {
    const svc = new KnowledgeChatEngineService(baseEnv, {} as any);
    await svc.onModuleInit();
    await expect(
      svc.execute({ runId: 'r1', prompt: 'hi', logPath: '/tmp/r1.ndjson', resumeSessionId: null }),
    ).rejects.toThrow(/engine is not running/i);
  });
});
