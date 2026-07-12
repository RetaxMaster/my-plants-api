import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { createServer, type AgentsRealtimeServer } from '@retaxmaster/agents-realtime-server';
import type { AgentProvider, AgentProviderStatus, SessionHistory } from '@retaxmaster/agents-realtime-protocol';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { KnowledgeChatOrchestrator } from './knowledge-chat-orchestrator.js';
import { buildEngineConfig } from './knowledge-chat-engine.config.js';

// The agents this host registers in the engine's provider registry. ONE source for the list: the
// registry (knowledge-chat-engine.config.ts), the forced re-probe fan-out below, and the DTO's accepted
// `provider` values all derive from it, so a third agent is added in exactly one place.
export const KNOWLEDGE_CHAT_PROVIDERS = ['claude', 'codex'] as const satisfies readonly AgentProvider[];

export interface ExecuteRequest {
  runId: string;
  // Which agent runs this turn. REQUIRED since agents-realtime 1.0.0 — the engine spawns a provider-
  // neutral runner and cannot guess. Omitting it makes /execute reject the run with 422.
  provider: AgentProvider;
  prompt: string;
  logPath: string;
  resumeSessionId: string | null;
}

// Owns the embedded realtime engine lifecycle. On boot it builds config, ensures the log + state dirs
// exist, and listen()s (binding 127.0.0.1). listen() also re-adopts still-running runners via the
// orchestrator's activeRuns() + the engine's durable run index. execute() is the localhost control-plane
// call the chat routes use to trigger a run (defense-in-depth even in-process: the package's own
// secret-gated /execute).
@Injectable()
export class KnowledgeChatEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeChatEngineService.name);
  private server: AgentsRealtimeServer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly orchestrator: KnowledgeChatOrchestrator,
  ) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  private get baseUrl(): string {
    const port = this.server?.port ?? this.env.KNOWLEDGE_CHAT_ENGINE_PORT;
    return `http://127.0.0.1:${port}`;
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.KNOWLEDGE_CHAT_ENGINE_ENABLED) {
      this.logger.warn('Knowledge-chat engine disabled (KNOWLEDGE_CHAT_ENGINE_ENABLED=false) — not listening.');
      return;
    }
    // Both dirs are engine preconditions: KNOWLEDGE_CHAT_LOG_DIR is the `logRoot` allow-list a run log
    // must live under, KNOWLEDGE_CHAT_STATE_DIR holds the durable run index. createServer creates them
    // itself, but we own them here too so a fresh checkout boots with no manual setup.
    await mkdir(this.env.KNOWLEDGE_CHAT_LOG_DIR, { recursive: true });
    await mkdir(this.env.KNOWLEDGE_CHAT_STATE_DIR, { recursive: true });
    // The orchestrator is BOTH the host-backend seam and the own-run locator (it is the only thing that
    // knows which runs belong to which conversation).
    this.server = createServer(buildEngineConfig(this.env, this.orchestrator, this.orchestrator));
    // Close the construction cycle: the orchestrator can only claim a run as "ours" if the engine can
    // resolve its log — which it can only answer once it exists. See runsForSession.
    this.orchestrator.setRunLogResolver(this.server.runLogResolver);
    await this.server.listen();
    this.logger.log(`Knowledge-chat engine listening on ${this.baseUrl} (re-adopted active runs).`);
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
      cwd: this.env.KNOWLEDGE_ENGINE_CWD,
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
      headers: { 'content-type': 'application/json', 'X-Agents-RT-Secret': this.env.KNOWLEDGE_CHAT_ENGINE_SECRET },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Engine /execute failed (${res.status}): ${text}`);
    }
  }
}
