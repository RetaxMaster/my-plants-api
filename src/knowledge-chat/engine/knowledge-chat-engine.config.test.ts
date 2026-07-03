import { describe, expect, it } from 'vitest';
import { buildEngineConfig, KNOWLEDGE_ENGINE_CLAUDE_ARGS } from './knowledge-chat-engine.config.js';

const env = {
  KNOWLEDGE_CHAT_ENGINE_PORT: 8010,
  KNOWLEDGE_CHAT_ENGINE_SECRET: 'secret-value',
  WEB_ORIGIN: 'http://localhost:8001',
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: 1_800_000,
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: 120_000,
  KNOWLEDGE_ENGINE_CWD: '/isolated/knowledge-engine',
  CLAUDE_BIN: 'claude',
} as any;

describe('buildEngineConfig', () => {
  it('maps env + orchestrator to the createServer config (127.0.0.1, cors, timeouts, claude launch)', () => {
    const orchestrator = {} as any;
    const cfg = buildEngineConfig(env, orchestrator);
    expect(cfg.port).toBe(8010);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.secret).toBe('secret-value');
    expect(cfg.corsOrigins).toEqual(['http://localhost:8001']);
    expect(cfg.timeouts).toEqual({ runMs: 1_800_000, bufferMs: 120_000 });
    expect(cfg.orchestrator).toBe(orchestrator);
    expect(cfg.claude).toEqual({ cwd: '/isolated/knowledge-engine', bin: 'claude', args: KNOWLEDGE_ENGINE_CLAUDE_ARGS });
  });
});
