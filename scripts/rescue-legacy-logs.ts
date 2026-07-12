// RUN THIS WITH THE API STOPPED. It opens the engine's own durable run index (KNOWLEDGE_CHAT_STATE_DIR)
// to adopt the rescued logs into it, and two writers on that one index at once is not a race we are
// entitled to lose quietly — the running API's engine instance holds the same index open.
import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';
import { createServer } from '@retaxmaster/agents-realtime-server';
import { loadEnv } from '../src/config/env.js';
import { KnowledgeChatTicketService } from '../src/knowledge-chat/engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';
import { buildEngineConfig } from '../src/knowledge-chat/engine/knowledge-chat-engine.config.js';
import { rescueLegacyLogs } from '../src/knowledge-chat/legacy-log-rescue.core.js';

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    // Build the engine WITHOUT listening: adoption is synchronous on the run index alone — it needs no
    // bound port, no runner, no agent. createServer is entitled to call the orchestrator (its own
    // constructor + config building do), so it is NOT stubbed — a fake would let a real wiring bug in
    // buildEngineConfig sail through undetected.
    const tickets = new KnowledgeChatTicketService(prisma as never, env);
    const orchestrator = new KnowledgeChatOrchestrator(prisma as never, tickets, env);
    const server = createServer(buildEngineConfig(env, orchestrator, orchestrator));

    const report = await rescueLegacyLogs(prisma, env.KNOWLEDGE_CHAT_LOG_DIR, server);

    console.log(`Rescued ${report.rescued.length} log(s): ${report.rescued.join(', ') || '(none)'}`);
    console.log(`Already canonical (untouched): ${report.alreadyCanonical}`);
    for (const s of report.skipped) {
      console.warn(`WARN: skipped run ${s.runId} — ${s.reason}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
