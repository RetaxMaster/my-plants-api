import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { createServer, type AgentsRealtimeServer } from '@retaxmaster/agents-realtime-server';
import type { AgentCommand, AgentProvider, AgentProviderStatus, CommandCatalog, SessionHistory } from '@retaxmaster/agents-realtime-protocol';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { EngineParams } from './engine-params.js';
import { KnowledgeChatOrchestrator } from './knowledge-chat-orchestrator.js';
import { buildEngineConfig } from './knowledge-chat-engine.config.js';

// The agents this host registers in the engine's provider registry. ONE source for the list: the
// registry (knowledge-chat-engine.config.ts), the forced re-probe fan-out below, and the DTO's accepted
// `provider` values all derive from it, so a third agent is added in exactly one place.
export const KNOWLEDGE_CHAT_PROVIDERS = ['claude', 'codex'] as const satisfies readonly AgentProvider[];

// A turn is EITHER a prompt OR a command — never both, never neither. The engine answers 400 on a body that
// carries both or neither, so we make that unrepresentable here instead of discovering it at runtime.
export type ExecuteRequest = {
  runId: string;
  // Which agent runs this turn. REQUIRED since agents-realtime 1.0.0 — the engine spawns a provider-neutral
  // runner and cannot guess. Omitting it makes /execute reject the run with 422.
  provider: AgentProvider;
  logPath: string;
  resumeSessionId: string | null;
  // Per-run env merged into the spawned runner's environment (the engine's supervisor already does
  // `{ ...process.env, ...req.env }`). The Plant Doctor uses it to inject PLANT_DOCTOR_SESSION_WORKSPACE
  // so a DOCTOR run's tools resolve THIS session's workspace — per-run, never a racy global. (See the
  // Task-2 seam note: the vendored /execute handler must thread the body `env` to the supervisor; that
  // minimal package thread is the one integration-gated dependency. The host side is wired here now.)
  env?: Record<string, string>;
} & ({ prompt: string; command?: never } | { command: AgentCommand; prompt?: never });

// The engine surface the shared service + the two controllers depend on. Both engine instances (KNOWLEDGE
// and DOCTOR) implement it, so the registry can hand back either behind one type (reuse-not-fork, Spec 3 §2).
export interface ChatEngine {
  readonly isRunning: boolean;
  readonly logDir: string;
  providerStatus(opts?: { force?: boolean }): Promise<AgentProviderStatus[]>;
  commandCatalog(provider: AgentProvider, opts?: { force?: boolean }): Promise<CommandCatalog>;
  loadHistory(provider: AgentProvider, providerSessionId: string): Promise<SessionHistory>;
  execute(req: ExecuteRequest): Promise<void>;
}

// Owns the embedded realtime engine lifecycle. On boot it builds config, ensures the log + state dirs
// exist, and listen()s (binding 127.0.0.1). listen() also re-adopts still-running runners via the
// orchestrator's activeRuns() + the engine's durable run index. execute() is the localhost control-plane
// call the chat routes use to trigger a run (defense-in-depth even in-process: the package's own
// secret-gated /execute).
// Param-driven so ONE class runs BOTH engines: the constructor bakes an `EngineParams` (KNOWLEDGE or
// DOCTOR) — its cwd/port/secret/log+state dirs — and the module provides two instances under the
// KNOWLEDGE_ENGINE / DOCTOR_ENGINE tokens (reuse-not-fork, Spec 3 §2).
@Injectable()
export class KnowledgeChatEngineService implements ChatEngine, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeChatEngineService.name);
  private server: AgentsRealtimeServer | null = null;

  constructor(
    private readonly params: EngineParams,
    @Inject(ENV) private readonly env: Env,
    private readonly orchestrator: KnowledgeChatOrchestrator,
  ) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  // The dir this engine's run logs live in — the registry hands it to the service so a run's logPath is
  // built under the RIGHT engine's dir (its `logRoot` allow-list), never the other engine's.
  get logDir(): string {
    return this.params.logDir;
  }

  private get baseUrl(): string {
    const port = this.server?.port ?? this.params.port;
    return `http://127.0.0.1:${port}`;
  }

  async onModuleInit(): Promise<void> {
    if (!this.params.enabled) {
      this.logger.warn(`Chat engine [${this.params.kind}] disabled — not listening.`);
      return;
    }
    // Both dirs are engine preconditions: logDir is the `logRoot` allow-list a run log must live under,
    // stateDir holds the durable run index. createServer creates them itself, but we own them here too so
    // a fresh checkout boots with no manual setup.
    await mkdir(this.params.logDir, { recursive: true });
    await mkdir(this.params.stateDir, { recursive: true });
    // The orchestrator is BOTH the host-backend seam and the own-run locator (it is the only thing that
    // knows which runs belong to which conversation).
    this.server = createServer(buildEngineConfig(this.params, this.env, this.orchestrator, this.orchestrator));
    // Close the construction cycle: the orchestrator can only claim a run as "ours" if the engine can
    // resolve its log — which it can only answer once it exists. See runsForSession.
    this.orchestrator.setRunLogResolver(this.server.runLogResolver);
    await this.server.listen();
    this.logger.log(`Chat engine [${this.params.kind}] listening on ${this.baseUrl} (re-adopted active runs).`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }

  // Per-agent availability (installed / authenticated / available), exactly as the engine's own /execute
  // gate sees it. We are CO-LOCATED with the engine, so we read it in-process instead of proxying our own
  // secret-gated HTTP control plane back to ourselves — same answer, one less hop, and the UI and the
  // gate cannot disagree. `available` is DERIVED by the package; never re-derive it. The `error` strings
  // are already scrubbed there (no tokens, no home paths), so they are safe to show a browser.
  // `force` bypasses the ~30s probe cache — the "I just logged in, re-check" flow.
  async providerStatus(opts?: { force?: boolean }): Promise<AgentProviderStatus[]> {
    const server = this.server;
    if (!server) return []; // engine disabled → no agent is runnable; the UI renders "none available"
    if (!opts?.force) return server.getAllProviderStatus();
    return Promise.all(KNOWLEDGE_CHAT_PROVIDERS.map((p) => server.getProviderStatus(p, { force: true })));
  }

  // The agent's command catalog — what the composer autocompletes over. Read IN-PROCESS, like
  // providerStatus: we are co-located with the engine, so proxying our own secret-gated HTTP back to
  // ourselves would only add a hop and a way for the two answers to disagree.
  //
  // The engine NEVER rejects here: an unharvestable catalog resolves to an empty list, and the composer
  // then degrades to plain prose (it never blocks input). An `unsupported` entry — `/clear` — is LISTED,
  // greyed and explained rather than hidden: hiding it would not stop a user typing it from muscle memory,
  // it would only stop us explaining why it is refused.
  async commandCatalog(provider: AgentProvider, opts?: { force?: boolean }): Promise<CommandCatalog> {
    const server = this.server;
    if (!server) return { provider, commands: [] }; // engine disabled → nothing to autocomplete
    return server.getCommandCatalog(provider, opts);
  }

  // A conversation's history, rebuilt by the engine as CANONICAL AgentEvents. Because we wired the
  // own-run locator, a conversation we ran is restored from OUR OWN logs — so a reopened chat keeps the
  // rich tool cards and diffs the live stream produced, instead of degrading to plain text (a native
  // re-read can return fewer items than the live stream did). Provider-neutral: the same call serves a
  // Claude session and a Codex thread, and the browser cannot tell which.
  //
  // This REPLACES the old approach of shipping the raw NDJSON log to the browser and parsing it there:
  // the log now carries out-of-band lines (header, identity, internal events) that must be filtered
  // exactly the way the socket filters them. Re-implementing that filter in the frontend would fork
  // engine logic into the browser — this keeps ONE implementation, in the engine.
  async loadHistory(provider: AgentProvider, providerSessionId: string): Promise<SessionHistory> {
    if (!this.server) throw new Error('Knowledge-chat engine is not running');
    return this.server.sessions.loadSessionHistory(provider, providerSessionId, {
      cwd: this.params.cwd,
    });
  }

  // Trigger a run: POST the engine's /execute with the shared secret header. The engine CREATES the log
  // itself (O_CREAT|O_EXCL — the host must NOT pre-create it), then spawns the runner for `provider`,
  // which drives that agent and appends canonical AgentEvent NDJSON, streamed to the browser over
  // Socket.IO. We never write the transcript ourselves.
  async execute(req: ExecuteRequest): Promise<void> {
    if (!this.server) throw new Error('Knowledge-chat engine is not running');
    const res = await fetch(`${this.baseUrl}/execute`, {
      method: 'POST',
      // Renamed in 1.0.0 (was X-Claude-RT-Secret). A stale header name means 401 on every call.
      headers: { 'content-type': 'application/json', 'X-Agents-RT-Secret': this.params.secret },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Engine /execute failed (${res.status}): ${text}`);
    }
  }
}
