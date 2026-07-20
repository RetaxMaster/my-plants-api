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
//   4. CONCURRENCY: this script is now SAFE TO RUN AGAINST A LIVE API — unlike its two siblings
//      (promote-legacy-system-messages.ts, rescue-legacy-logs.ts), it does NOT need the API/engines
//      stopped. `KnowledgeChatRun.systemMessageText` is write-once (set exactly once inside `admitRun`'s
//      `.create()`, never `.update()`d anywhere — verified by a full-repo grep) so a plain unconditional
//      write is safe: there is no in-place row to race. `KnowledgeChatSession.pendingSystemMessage` is an
//      ACTIVE MAILBOX SLOT that live traffic writes concurrently (claimed by `admitRun`, restored by
//      `transitionConsumed`, queued by proposal decline/failure paths), so every write to it here is a
//      COMPARE-AND-SWAP guarded by the exact value this pass read (mirroring the idiom
//      `system-message-delivery.ts` already uses for the same column). Losing that race is not treated as
//      a failure: the row is left untouched and reported as a named skip, and a later re-run (this script
//      is idempotent — see point 5) picks up whatever state it settles into. See the big comments in
//      `normalize-system-message-marker.core.ts` above each loop for the full reasoning.
//   5. This script IS IDEMPOTENT. `strip()` in the core module only rewrites a value that still carries
//      the prefix, so a second (or Nth) run reports zero updates and changes nothing on disk. Re-running
//      it after a partial failure, a skipped race, or just to double-check, is always safe.
//   6. `KnowledgeChatRun.prompt` is DELIBERATELY NEVER REWRITTEN by this script. Only
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
      // COMPARE-AND-SWAP: the WHERE clause re-asserts the exact value this pass read, in the same idiom as
      // `system-message-delivery.ts`'s `updateMany ... where pendingSystemMessage: null`. `count === 1`
      // means the write landed on the row unchanged since the read; `count === 0` means something else
      // (a concurrent claim, restore, or fresh queue) reached it first, so this pass MUST NOT overwrite
      // whatever is there now.
      updateSessionIfUnchanged: async (id, from, to) => {
        const res = await prisma.knowledgeChatSession.updateMany({
          where: { id, pendingSystemMessage: from },
          data: { pendingSystemMessage: to },
        });
        return res.count === 1;
      },
      surveyCompleted: afterSurvey,
      // Per-row progress, printed AS EACH ROW LANDS — not batched behind the final summary — so an
      // operator recovering from a run that throws partway through still has a paper trail of what already
      // committed. Mirrors `Promoted ${path}` in promote-legacy-system-messages.ts and the per-run outcome
      // logging in rescue-legacy-logs.ts.
      onRunUpdated: (id) => console.log(`  run ${id}: systemMessageText normalised`),
      onSessionUpdated: (id) => console.log(`  session ${id}: pendingSystemMessage normalised`),
      onSessionSkipped: (id, reason) => console.warn(`  SKIPPED session ${id}: ${reason}`),
    });

    console.log(`Normalised ${result.runsUpdated} KnowledgeChatRun.systemMessageText row(s).`);
    console.log(`Normalised ${result.sessionsUpdated} KnowledgeChatSession.pendingSystemMessage row(s).`);
    if (result.sessionsSkipped.length > 0) {
      console.warn(
        `${result.sessionsSkipped.length} session row(s) were SKIPPED (lost the CAS race) — re-run this ` +
        `script to pick them up once traffic settles, or leave them: a value written by post-change code ` +
        `carries no marker and needs no further handling.`,
      );
    }
    console.log('KnowledgeChatRun.prompt was NOT touched (deliberate — see this file\'s header comment).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
