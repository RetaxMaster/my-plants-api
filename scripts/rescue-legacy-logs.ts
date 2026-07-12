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

// CLAIM the engine's port and HOLD it for the entire rescue — this is a LOCK, not a check.
//
// The durable run index has exactly ONE legitimate writer. A probe that binds and immediately releases
// only proves the engine was down at one instant: the API (or a second copy of this script) can start
// inside the gap between the check and the work, and then two processes write that one index — the exact
// race the guard exists to prevent (TOCTOU). So we keep the socket LISTENING for the whole run and close
// it in a `finally`. While we hold it, the API cannot start its engine (it would hit EADDRINUSE on this
// very port) and neither can a second copy of this script. That turns "please stop the API" from a polite
// request into real mutual exclusion.
//
// EADDRINUSE is the ONLY signal we treat as "already up": any other bind failure (e.g. permission) is a
// real, unrelated error and is rethrown as-is rather than mis-reported as "the API is running".
async function acquireEngineLock(port: number): Promise<{ release: () => Promise<void> }> {
  const lock = createTcpProbe();
  await new Promise<void>((resolve, reject) => {
    lock.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Refusing to run: 127.0.0.1:${port} is already bound, which means the knowledge-chat engine ` +
          `(embedded in the API process) — or another copy of this script — is up. The durable run index ` +
          `has exactly one writer, so running now would corrupt it. Stop the API first (in production: ` +
          `\`pm2 stop my-plants-api\`) and re-run this script. No file was touched.`,
        ));
        return;
      }
      reject(err);
    });
    lock.once('listening', () => resolve());
    lock.listen(port, '127.0.0.1');
  });

  return {
    release: () => new Promise<void>((resolve) => lock.close(() => resolve())),
  };
}

async function main() {
  const env = loadEnv();

  // MUST come before anything else — including constructing the Prisma client — so a refusal exits without
  // touching a single file. And it is HELD (not released) until the `finally` below: for as long as this
  // script runs, nothing else can bring the engine up.
  const lock = await acquireEngineLock(env.KNOWLEDGE_CHAT_ENGINE_PORT);
  console.log(`Holding 127.0.0.1:${env.KNOWLEDGE_CHAT_ENGINE_PORT} for the duration — the API cannot start while this runs.`);

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
    // Release the single-writer lock LAST: the API must not be able to come up until every adoption and
    // backfill above has landed.
    await lock.release();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
