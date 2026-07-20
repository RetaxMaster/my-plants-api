// Spec §3.5, Task 26 — strip the retired `[system] ` marker out of the live database rows.
//
// OPERATIONAL PROCEDURE (production and local alike):
//
//   1. A verified database backup MUST already exist before this runs. Do not invent a new backup
//      mechanism here — this project's deploy already takes one (see docs/deploy.md §10.3, the
//      pre-deploy production DB backup into `database-backup/`); this script assumes that dump already
//      happened for the environment it is about to touch.
//   2. Run `npm run migrate:promote-system-messages` FIRST (no `--apply` is even required — the survey
//      itself is what matters here) and record its printed counts. This is not optional ceremony: the
//      recognizer that promotes legacy `.ndjson` logs uses `KnowledgeChatRun.systemMessageText` AS ITS
//      MATCHING AUTHORITY (see src/knowledge-chat/legacy-system-recognizer.ts). If this script strips the
//      marker from that column BEFORE the survey/promotion runs, the recognizer's exact-match check
//      against the log's stored prompt silently stops matching — a promotable file looks IDENTICAL to a
//      file with nothing to promote. There is no error, no exception, just a quieter corpus. That is why
//      `assertSurveyRanFirst` (normalize-system-message-marker.core.ts) refuses to run without proof the
//      survey happened first, rather than merely documenting the order here.
//   3. THEN run this script with `--after-survey`:
//        npm run migrate:normalize-system-marker -- --after-survey
//      Omitting the flag is a hard refusal — no row is read for update and nothing is written.
//   4. This script IS IDEMPOTENT. `strip()` in the core module only rewrites a value that still carries
//      the prefix, so a second (or Nth) run reports zero updates and changes nothing on disk. Re-running
//      it after a partial failure, or just to double-check, is always safe.
//   5. `KnowledgeChatRun.prompt` is DELIBERATELY NEVER REWRITTEN by this script. Only
//      `KnowledgeChatRun.systemMessageText` and `KnowledgeChatSession.pendingSystemMessage` are touched.
//      This is why the `prompt` column is permanently MIXED after this runs (some rows still carry the
//      marker inside their concatenated prompt, some never had it) — see
//      src/knowledge-chat/legacy-prompt-split.ts for the de-concatenation rule that exists BECAUSE of this
//      deliberate asymmetry. Do not "fix" this by extending the script to rewrite `prompt` too.
//
// No rollback mechanism is implemented or improvised here beyond the pre-existing backup from step 1 —
// restoring from that dump is the only recovery path, and that is a fact about the deploy process, not
// something this script re-implements.
import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env.js';
import { normalizeMarkerColumns } from '../src/knowledge-chat/normalize-system-message-marker.core.js';

async function main(): Promise<void> {
  // loadEnv() is called for the same reason every sibling migration script calls it: it validates the
  // process is configured at all before touching the database, even though this script itself reads no
  // env var directly.
  loadEnv();
  const afterSurvey = process.argv.includes('--after-survey');

  const prisma = new PrismaClient();
  try {
    const result = await normalizeMarkerColumns({
      loadRuns: async () => {
        const rows = await prisma.knowledgeChatRun.findMany({
          where: { systemMessageText: { startsWith: '[system] ' } },
          select: { id: true, systemMessageText: true },
        });
        // The `where` above is an optimisation (never fetch rows that cannot possibly need a rewrite), not
        // the correctness boundary — `normalizeMarkerColumns`'s own `strip()` re-checks the prefix per row
        // and is what actually decides whether to write, which is what keeps this idempotent.
        return rows.map((r) => ({ id: r.id, systemMessageText: r.systemMessageText as string }));
      },
      loadSessions: async () => {
        const rows = await prisma.knowledgeChatSession.findMany({
          where: { pendingSystemMessage: { startsWith: '[system] ' } },
          select: { id: true, pendingSystemMessage: true },
        });
        return rows.map((r) => ({ id: r.id, pendingSystemMessage: r.pendingSystemMessage as string }));
      },
      updateRun: async (id, value) => {
        await prisma.knowledgeChatRun.update({ where: { id }, data: { systemMessageText: value } });
      },
      updateSession: async (id, value) => {
        await prisma.knowledgeChatSession.update({ where: { id }, data: { pendingSystemMessage: value } });
      },
      surveyCompleted: afterSurvey,
    });

    console.log(`Normalised ${result.runsUpdated} KnowledgeChatRun.systemMessageText row(s).`);
    console.log(`Normalised ${result.sessionsUpdated} KnowledgeChatSession.pendingSystemMessage row(s).`);
    console.log('KnowledgeChatRun.prompt was NOT touched (deliberate — see this file\'s header comment).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
