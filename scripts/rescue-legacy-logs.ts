// RUN THIS WITH THE API STOPPED. It opens the engine's own durable run index (KNOWLEDGE_CHAT_STATE_DIR)
// to adopt the rescued logs into it, and two writers on that one index at once is not a race we are
// entitled to lose quietly — the running API's engine instance holds the same index open, and the live
// API would never see these adoptions in its in-memory state anyway. This precondition is ENFORCED below
// (assertEngineNotRunning), not just documented — see its comment for why.
import '../src/config/load-env-file.js';
import { createServer as createTcpProbe } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createServer } from '@retaxmaster/agents-realtime-server';
import { loadEnv } from '../src/config/env.js';
import { KnowledgeChatTicketService } from '../src/knowledge-chat/engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';
import { buildEngineConfig } from '../src/knowledge-chat/engine/knowledge-chat-engine.config.js';
import { rescueLegacyLogs } from '../src/knowledge-chat/legacy-log-rescue.core.js';

// Prove the engine is NOT running by trying to bind its own port on localhost. The durable run index has
// exactly ONE legitimate writer; if something is already listening on this port, that is either the API
// (whose embedded engine holds the index open) or an engine instance left running some other way — either
// way, adopting logs from here would race it. EADDRINUSE is the ONLY signal we treat as "already up": any
// other bind failure (e.g. permission) is a real, unrelated error and is rethrown as-is rather than
// mis-reported as "the API is running".
async function assertEngineNotRunning(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createTcpProbe();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Refusing to run: 127.0.0.1:${port} is already bound, which means the knowledge-chat engine ` +
          `(embedded in the API process) is up. The durable run index has exactly one writer — running ` +
          `this script while the API is live would corrupt it. Stop the API first (in production: ` +
          `\`pm2 stop my-plants-api\`) and re-run this script. No file was touched.`,
        ));
        return;
      }
      reject(err);
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

async function main() {
  const env = loadEnv();

  // MUST run before anything else — including constructing the Prisma client — so a positive detection
  // exits without touching a single file.
  await assertEngineNotRunning(env.KNOWLEDGE_CHAT_ENGINE_PORT);

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
    // Canonical bytes already on disk from a previous, interrupted run — re-adopted + re-backfilled, not
    // re-translated. See legacy-log-rescue.core.ts (FIX 1) for why `isLegacyLog` alone cannot gate this.
    console.log(`Repaired ${report.repaired.length} partially-rescued log(s): ${report.repaired.join(', ') || '(none)'}`);
    console.log(`Already canonical (untouched): ${report.alreadyCanonical}`);
    // A rescued log is not necessarily a WHOLE log. Say which ones came back with holes, loudly, instead of
    // letting "rescued" imply "intact".
    for (const d of report.degraded) {
      console.warn(`WARN: run ${d.runId} was rescued but is NOT lossless — ${d.corrupt} of ${d.linesIn} legacy lines could not be translated and are now 'unsupported' placeholders.`);
    }
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
