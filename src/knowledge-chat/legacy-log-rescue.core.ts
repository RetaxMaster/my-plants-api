import { readdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isLegacyLog, scanCanonicalLog, translateLegacyClaudeLog, validateCanonicalLog, type LogExpectation } from '@retaxmaster/agents-realtime-server';
import type { AgentProvider, DoneStatus } from '@retaxmaster/agents-realtime-protocol';

export interface LogIndex {
  adoptExistingLog(entry: { logPath: string; startedAtMs: number; expect: LogExpectation }): void;
}

export interface RescueReport {
  rescued: string[];
  // Canonical-but-unfinished files (FIX 1): the file was already translated on a previous run, but the
  // process died before `adoptExistingLog`/the backfill landed, so it was invisible or excluded from
  // history despite being byte-perfect. Re-adopted + re-backfilled, never re-translated.
  repaired: string[];
  skipped: { runId: string; reason: string }[];
  alreadyCanonical: number;
  // Rescued, but NOT losslessly: `corrupt` counts legacy lines the translator could not understand, which
  // survive in the canonical log as `unsupported` events rather than as their original content. The
  // conversion never aborts on them, so without this the operator would see a clean "rescued" and never
  // learn that part of the transcript came back as a placeholder. (Our own old sentinels — `claude_rt_*` and
  // friends — are NOT counted here: they are ours, not content.)
  degraded: { runId: string; corrupt: number; linesIn: number }[];
}

// Our DB status → the package's DoneStatus, 1:1. Deliberately NO default/fallback branch: a default would
// FABRICATE an outcome for exactly the runs we know least about (see translateLegacyClaudeLog's `status`
// doc). A run whose status is not one of these three terminal values is not terminal and is skipped before
// this map is ever consulted.
const DONE_STATUS_BY_RUN_STATUS: Record<string, DoneStatus> = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const sha256 = (serialized: string) => createHash('sha256').update(serialized).digest('hex');

// Replace `path` with `content` ATOMICALLY: write to a sibling temp file on the SAME filesystem, fsync it
// durable, then rename() over the target. `rename` within one directory is atomic on every filesystem we
// run on — the original is either the OLD bytes or the NEW bytes, in full, never a truncated mix. A plain
// `writeFile(path, …)` truncates the one and only original the instant it opens the file: a crash, a full
// disk, or an I/O error mid-write leaves a half-written NDJSON and destroys BOTH the legacy original and
// the conversion, and the engine's reader is fail-closed — one bad line bricks the whole conversation.
async function atomicReplaceFile(path: string, content: string): Promise<void> {
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(tmpPath, content, 'utf8');
    const fh = await open(tmpPath, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

// Rescue every pre-1.0 (raw Claude stream-json, no header) `.ndjson` log under `logDir`, and REPAIR any
// canonical log left behind by a previous run that died mid-migration. Filenames are `<runId>.ndjson` —
// the run row is our source of truth for everything the legacy file itself never recorded (the user
// prompt, the terminal, the real agent session id).
//
// The full 3-step sequence for a legacy file — translate → write → adopt → backfill the run row — is NOT
// atomic as a whole (the process can die between any two steps), so `isLegacyLog` alone cannot be the
// idempotency gate: a canonical file is not automatically "done". We discriminate by the run row's
// `sessionTracked` flag instead — see the per-file loop below for the full reasoning.
export async function rescueLegacyLogs(prisma: PrismaClient, logDir: string, index: LogIndex): Promise<RescueReport> {
  const report: RescueReport = { rescued: [], repaired: [], skipped: [], alreadyCanonical: 0, degraded: [] };

  const entries = await readdir(logDir);
  const ndjsonFiles = entries.filter((f) => f.endsWith('.ndjson'));
  if (ndjsonFiles.length === 0) return report;

  const files: { runId: string; path: string; text: string; legacy: boolean }[] = [];
  for (const file of ndjsonFiles) {
    const path = join(logDir, file);
    const text = await readFile(path, 'utf8');
    files.push({ runId: basename(file, '.ndjson'), path, text, legacy: isLegacyLog(text) });
  }

  // The DB lookup now happens for EVERY file, canonical or not — a canonical file whose run row shows
  // `sessionTracked === false` is a run that was translated on a previous pass but never finished
  // adopting/backfilling, and only the DB can tell us that.
  const runIds = files.map((f) => f.runId);
  const runs = await prisma.knowledgeChatRun.findMany({
    where: { id: { in: runIds } },
    include: { session: true },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));

  for (const { runId, path, text, legacy } of files) {
    if (!legacy) {
      const run = runById.get(runId);

      // `sessionTracked` is exactly "this run was executed by an engine that records the session id" —
      // every pre-1.0 row is `false` until the backfill flips it. So `true` (finished) or no run row at
      // all (none of our business — not one of ours, or already cleaned up) means: leave it COMPLETELY
      // alone. In particular, NEVER call `adoptExistingLog` on a log the engine itself produced — the
      // package explicitly refuses a run it spawned, and that call would throw.
      if (!run || run.sessionTracked) {
        report.alreadyCanonical++;
        continue;
      }

      // A canonical file + `sessionTracked === false` is NECESSARY but not SUFFICIENT evidence of a
      // partial rescue: the same flag can also be false on a run the engine genuinely spawned (e.g. a
      // migration's blanket backfill ran once over whatever rows existed at the time, or a session report
      // that legitimately failed under `sessionReportFailurePolicy: "continue"`). We do not have to guess
      // which: the log ITSELF carries the answer. `log.identity` is a line only the RUNNER ever writes,
      // for its own re-adoption — a translated/rescued log (a pure function over legacy text) never
      // produces one. So `scan.sawIdentity` is the package's own, structural way to say "this engine
      // spawned this run"; trusting our own DB flag over it is exactly the mistake that would make us call
      // `adoptExistingLog` on a run the package refuses to adopt (see below) and crash the whole batch.
      const scan = scanCanonicalLog(text);
      if (!scan.ok) {
        report.skipped.push({ runId, reason: `canonical file failed to scan: ${scan.reason}` });
        continue;
      }
      if (scan.header.runId !== runId) {
        report.skipped.push({ runId, reason: 'canonical file header runId does not match its filename' });
        continue;
      }
      if (scan.sawIdentity) {
        // Provably engine-spawned: NOT a rescue candidate, regardless of `sessionTracked`. Never call
        // `adoptExistingLog` on it — the package explicitly refuses a run it spawned, and that call would
        // throw and abort the whole batch. Reported via `skipped` (not silently folded into
        // `alreadyCanonical`) because an untracked session on a genuinely-run conversation is worth an
        // operator's attention, even though it is not this script's job to fix it.
        report.skipped.push({
          runId,
          reason: 'canonical file was spawned by this engine (carries a runner identity) — not a legacy-rescue candidate; sessionTracked=false here is unrelated to the pre-1.0 migration and should be investigated separately',
        });
        continue;
      }

      // A genuinely PARTIALLY-RESCUED file: canonical bytes already on disk (no runner identity — this is
      // rescue output, not a live run), but the process died before adoption and/or the backfill landed.
      // Re-adopt (documented idempotent: a no-op on an already-adopted terminal run, a REPAIR on a
      // half-adopted one) and re-run the backfill. We do NOT re-translate — the canonical text is already
      // there.
      //
      // `startedAtMs` for the repair MUST come from the log's own header, never the DB: the package
      // requires it to equal the header's value, because `rebuildFromLogs()` reads it from the header if
      // the index is ever lost — letting the two disagree would silently reorder the user's history.
      const providerSessionId = run.providerSessionId ?? run.session?.providerSessionId ?? null;
      if (!providerSessionId) {
        report.skipped.push({ runId, reason: 'no agent session id on the run or its session — nothing to bind the log to' });
        continue;
      }

      const expect: LogExpectation = { runId, provider: scan.header.provider, providerSessionId };
      index.adoptExistingLog({ logPath: path, startedAtMs: scan.header.startedAtMs, expect });

      await prisma.knowledgeChatRun.update({
        where: { id: runId },
        data: { providerSessionId, sessionTracked: true },
      });

      report.repaired.push(runId);
      continue;
    }

    const run = runById.get(runId);
    if (!run) {
      report.skipped.push({ runId, reason: 'no matching run row in the database' });
      continue;
    }

    // Map our terminal status to the package's DoneStatus with NO default. A run still QUEUED/RUNNING has
    // no terminal outcome to record, and fabricating one is worse than skipping it.
    const doneStatus = DONE_STATUS_BY_RUN_STATUS[run.status];
    if (!doneStatus) {
      report.skipped.push({ runId, reason: `run is not terminal (status=${run.status})` });
      continue;
    }

    // The agent session id: OUR DB is authoritative, never the stale id sitting in the legacy file itself
    // (translateLegacyClaudeLog overrides it either way). Prefer the run's own record; fall back to the
    // session's. Neither present → there is nothing to bind the rescued log to, so skip loudly rather than
    // adopt against a made-up identity.
    const providerSessionId = run.providerSessionId ?? run.session?.providerSessionId ?? null;
    if (!providerSessionId) {
      report.skipped.push({ runId, reason: 'no agent session id on the run or its session — nothing to bind the log to' });
      continue;
    }

    // The legacy file never recorded the user's prompt (it went to `claude` on stdin). Without it, every
    // rescued turn would show the agent answering a blank question — so a run with no stored prompt is not
    // rescuable at all.
    if (!run.prompt) {
      report.skipped.push({ runId, reason: 'run has no stored prompt — the legacy file never captured it either' });
      continue;
    }

    const startedAtMs = (run.startedAt ?? run.createdAt).getTime();
    const expect: LogExpectation = { runId, provider: run.provider as AgentProvider, providerSessionId };

    const { canonical, stats } = translateLegacyClaudeLog({
      legacy: text,
      runId,
      providerSessionId,
      userPrompt: run.prompt,
      startedAtMs,
      status: doneStatus,
      hashUnsupported: sha256,
    });

    // VALIDATE BEFORE REPLACING THE ORIGINAL. The engine's reader is FAIL-CLOSED: one unparseable interior
    // line rejects the ENTIRE conversation — a malformed log does not degrade a chat, it BRICKS it. This is
    // the one moment the failure is still cheap: the original legacy file is still on disk, untouched, and
    // we can just skip and move on to the next log.
    const verdict = validateCanonicalLog(canonical, expect);
    if (!verdict.ok) {
      report.skipped.push({ runId, reason: `converted log failed validation: ${verdict.reasons.join('; ')}` });
      continue; // original left untouched
    }

    // ATOMIC replace (FIX 2): write the temp file, fsync it durable, then rename() over the original. The
    // original is never truncated — it is either fully replaced or left completely untouched by a crash,
    // a full disk, or an I/O error mid-write.
    await atomicReplaceFile(path, canonical);

    // ADOPTION IS MANDATORY, not optional cleanup. The engine resolves logs by runId through its DURABLE
    // INDEX, never by path — that invariant is what stops a host bug from serving another conversation's
    // file. A converted log sitting in logRoot that was never adopted is INVISIBLE to the engine: the
    // symptom is `OwnRunLogUnavailableError: no log path in the durable run index`, a 500 whose message
    // never points back at this migration. `beginRun` cannot be reused here — it creates the log with
    // O_CREAT|O_EXCL and throws against a file that already exists.
    //
    // If the process dies right here — after the write, before this call or the backfill below — the file
    // is now canonical but still `sessionTracked: false` on its run row. The NEXT run of this script picks
    // that exact state up in the `!legacy` branch above and repairs it: that is precisely why the
    // idempotency gate could not stay `isLegacyLog` alone (FIX 1).
    index.adoptExistingLog({ logPath: path, startedAtMs, expect });

    // BACKFILL THE RUN ROW — this step is OURS, and it is on no upstream checklist. Our own all-or-nothing
    // membership rule (`runsForSession` in knowledge-chat-orchestrator.ts) EXCLUDES a run whose
    // providerSessionId is null and sessionTracked is false — which is exactly what every pre-1.0 row looks
    // like before this write. Without it the rescued log is byte-perfect and adopted, and the conversation
    // still never reads it: `runsForSession` never counts it as a member of the session it belongs to.
    await prisma.knowledgeChatRun.update({
      where: { id: runId },
      data: { providerSessionId, sessionTracked: true },
    });

    report.rescued.push(runId);
    // Rescued ≠ lossless. Say so when it wasn't: a line the translator could not read came back as an
    // `unsupported` placeholder, and the operator deserves to know which conversation is missing content
    // rather than reading "rescued" and assuming it is whole.
    if (stats.corrupt > 0) report.degraded.push({ runId, corrupt: stats.corrupt, linesIn: stats.linesIn });
  }

  return report;
}
