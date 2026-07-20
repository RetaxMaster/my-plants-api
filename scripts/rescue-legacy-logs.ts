// RUN THIS WITH THE API STOPPED. It opens the engine's own durable run index (KNOWLEDGE_CHAT_STATE_DIR)
// to adopt the rescued logs into it, and two writers on that one index at once is not a race we are
// entitled to lose quietly — the running API's engine instance holds the same index open, and the live
// API would never see these adoptions in its in-memory state anyway. This precondition is ENFORCED below
// (assertEngineNotRunning), not just documented — see its comment for why.
import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';
import { createServer } from '@retaxmaster/agents-realtime-server';
import { loadEnv } from '../src/config/env.js';
import { KnowledgeChatTicketService } from '../src/knowledge-chat/engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';
import { buildEngineConfig } from '../src/knowledge-chat/engine/knowledge-chat-engine.config.js';
import { knowledgeEngineParams } from '../src/knowledge-chat/engine/engine-params.js';
import { rescueLegacyLogs } from '../src/knowledge-chat/legacy-log-rescue.core.js';
import { acquireEngineLock } from './lib/acquire-engine-port-lock.js';

// The lock's TOCTOU reasoning + EADDRINUSE-only signal now live once, in acquireEngineLock — shared with
// promote-legacy-system-messages.ts rather than forked (see that helper's own header comment).
// No "stop ... first" phrasing here at all — acquireEngineLock's own message already says "Stop it first
// and re-run this script." once. This description supplies only the diagnostic and the prod-specific
// command, so the composed refusal says "stop" exactly once instead of twice with the command sandwiched
// in between.
const KNOWLEDGE_CHAT_ENGINE_ALREADY_UP =
  'the knowledge-chat engine (embedded in the API process) — or another copy of this script — is up. ' +
  'The durable run index has exactly one writer, so running now would corrupt it. In production: ' +
  '`pm2 stop my-plants-api`.';

async function main() {
  const env = loadEnv();

  // MUST come before anything else — including constructing the Prisma client — so a refusal exits without
  // touching a single file. And it is HELD (not released) until the `finally` below: for as long as this
  // script runs, nothing else can bring the engine up.
  const lock = await acquireEngineLock(env.KNOWLEDGE_CHAT_ENGINE_PORT, KNOWLEDGE_CHAT_ENGINE_ALREADY_UP);
  console.log(`Holding 127.0.0.1:${env.KNOWLEDGE_CHAT_ENGINE_PORT} for the duration — the API cannot start while this runs.`);

  const prisma = new PrismaClient();
  try {
    // Build the engine WITHOUT listening: adoption is synchronous on the run index alone — it needs no
    // bound port, no runner, no agent. createServer is entitled to call the orchestrator (its own
    // constructor + config building do), so it is NOT stubbed — a fake would let a real wiring bug in
    // buildEngineConfig sail through undetected.
    const kparams = knowledgeEngineParams(env);
    const tickets = new KnowledgeChatTicketService(prisma as never, env);
    const orchestrator = new KnowledgeChatOrchestrator(kparams, prisma as never, tickets);
    const server = createServer(buildEngineConfig(kparams, env, orchestrator, orchestrator));

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
