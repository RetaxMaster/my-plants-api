import { describe, expect, it, vi } from 'vitest';
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

/**
 * The service refuses to execute unless `server` is set; these tests only exercise the HTTP body shape, so
 * a truthy stand-in is enough. Reaching in is deliberate: standing up a real engine would bind a port,
 * which no test in this repo does.
 */
function makeRunningEngineServiceForTest() {
  const service = Object.create(KnowledgeChatEngineService.prototype) as KnowledgeChatEngineService;
  Object.assign(service, {
    server: { port: 9999 },
    params: { ...params, secret: 'test-secret', port: 9999 },
  });
  return service;
}

describe('execute() request body', () => {
  it('sends systemMessage as its own field, never concatenated into the prompt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fakeFetch);

    const service = makeRunningEngineServiceForTest();
    await service.execute({
      runId: 'run-1',
      provider: 'claude',
      logPath: '/tmp/x.ndjson',
      resumeSessionId: null,
      prompt: 'How is my fern?',
      systemMessage: 'The user declined your request.',
    });

    expect(calls[0]!.body).toMatchObject({
      prompt: 'How is my fern?',
      systemMessage: 'The user declined your request.',
    });
    vi.unstubAllGlobals();
  });

  it('allows a system-message-only turn with a null prompt', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => '' } as unknown as Response;
      }),
    );

    const service = makeRunningEngineServiceForTest();
    await service.execute({
      runId: 'run-2',
      provider: 'claude',
      logPath: '/tmp/y.ndjson',
      resumeSessionId: null,
      prompt: null,
      systemMessage: 'The user still has not approved the request.',
    });

    expect(bodies[0]!.prompt).toBeNull();
    expect(bodies[0]!.systemMessage).toBe('The user still has not approved the request.');
    vi.unstubAllGlobals();
  });
});
