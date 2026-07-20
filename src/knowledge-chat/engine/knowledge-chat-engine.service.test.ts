import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  uploadDir: '/tmp/knowledge-chat-test-uploads',
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

/**
 * A REAL service instance, pointed at throwaway directories, for the construction tests below.
 *
 * It exercises `prepareServer()` — the directory preconditions plus `createServer()` — and NEVER
 * `listen()`. That split is the whole point: `createServer()` validates its configuration but binds
 * nothing, so these tests cover the construction-time contract without leaving a socket open. The port is
 * still set to 0 so that even a future accidental `listen()` could not collide with the dev API.
 */
function makeEngineServiceForBootTest(overrides: Partial<EngineParams>) {
  const orchestrator = {
    activeRuns: async () => [],
    runStarted: async () => {},
    runFinished: async () => {},
    validateTicket: async () => null,
    runsForSession: async () => [],
    setRunLogResolver: () => {},
  };
  return new KnowledgeChatEngineService(
    { ...params, enabled: true, port: 0, ...overrides },
    baseEnv,
    orchestrator as any,
  );
}

describe('upload root construction (spec §4.2, B7)', () => {
  it('creates the upload root on a FRESH boot where the directory does not exist', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'ar3-')), 'uploads-that-do-not-exist');
    const service = makeEngineServiceForBootTest({
      uploadDir: root,
      logDir: join(root, '..', 'logs'),
      stateDir: join(root, '..', 'state'),
    });

    await service['prepareServer']();

    const st = await stat(root);
    expect(st.isDirectory()).toBe(true);
    // "Works on a machine that already has the directory" is exactly the failure this hides — the package
    // resolves uploadRoot with realpathSync and THROWS if it cannot, so a default under storage/ is not
    // enough on a fresh checkout.
    expect(st.mode & 0o077).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to boot on a GROUP-WRITABLE upload root', async () => {
    // B7 is a boot-time contract and this refusal is the DESIRED failure direction: anyone who can create
    // or rename entries in the root can redirect the engine's attachment writes out of it, and the TTL
    // sweep deletes directories under it recursively.
    const base = await mkdtemp(join(tmpdir(), 'ar3-gw-'));
    const root = join(base, 'uploads');
    await mkdir(root, { recursive: true });
    await chmod(root, 0o770);
    const service = makeEngineServiceForBootTest({
      uploadDir: root,
      logDir: join(base, 'logs'),
      stateDir: join(base, 'state'),
    });

    // This rejects inside createServer(), BEFORE listen() — so no port is ever bound on this path. Note
    // prepareServer() mkdir's with `recursive: true`, which does NOT re-chmod an existing directory, so
    // the 0o770 mode set above survives to reach the check.
    await expect(service['prepareServer']()).rejects.toThrow(/uploadRoot|permission|writable/i);
    await rm(base, { recursive: true, force: true });
  });

  it('refuses to boot on an upload root owned by another OS user', async () => {
    // /root is owned by root and is not the engine's user, so realpath succeeds and the OWNERSHIP check is
    // the thing that fails — which is precisely the check under test. Also a construction-time throw.
    const base = await mkdtemp(join(tmpdir(), 'ar3-own-'));
    const service = makeEngineServiceForBootTest({
      uploadDir: '/root',
      logDir: join(base, 'logs'),
      stateDir: join(base, 'state'),
    });
    await expect(service['prepareServer']()).rejects.toThrow();
    await rm(base, { recursive: true, force: true });
  });
});
