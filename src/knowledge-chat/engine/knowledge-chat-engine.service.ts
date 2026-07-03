import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { createServer, type ClaudeRealtimeServer } from '@retaxmaster/claude-realtime-server';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { KnowledgeChatOrchestrator } from './knowledge-chat-orchestrator.js';
import { buildEngineConfig } from './knowledge-chat-engine.config.js';

export interface ExecuteRequest {
  runId: string;
  prompt: string;
  logPath: string;
  resumeSessionId: string | null;
}

// Owns the embedded realtime engine lifecycle. On boot it builds config, ensures the log dir exists,
// and listen()s (binding 127.0.0.1). listen() also re-adopts still-running children via the
// orchestrator's activeRuns(). execute() is the localhost control-plane call the chat routes use to
// trigger a run (defense-in-depth even in-process: the package's own secret-gated /execute).
@Injectable()
export class KnowledgeChatEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeChatEngineService.name);
  private server: ClaudeRealtimeServer | null = null;

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
    await mkdir(this.env.KNOWLEDGE_CHAT_LOG_DIR, { recursive: true });
    this.server = createServer(buildEngineConfig(this.env, this.orchestrator));
    await this.server.listen();
    this.logger.log(`Knowledge-chat engine listening on ${this.baseUrl} (re-adopted active runs).`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }

  // Trigger a run: POST the engine's /execute with the shared secret header. The engine spawns claude
  // (prepending --resume <uuid> iff resumeSessionId), redirects stdout→logPath, and streams over
  // Socket.IO. We never write the transcript ourselves — claude does, via the engine's shell redirect.
  async execute(req: ExecuteRequest): Promise<void> {
    if (!this.server) throw new Error('Knowledge-chat engine is not running');
    const res = await fetch(`${this.baseUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Claude-RT-Secret': this.env.KNOWLEDGE_CHAT_ENGINE_SECRET },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Engine /execute failed (${res.status}): ${text}`);
    }
  }
}
