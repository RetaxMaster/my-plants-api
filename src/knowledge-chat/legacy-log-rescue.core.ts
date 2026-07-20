import { readdir, readFile, writeFile, rename, open, rm, stat, chmod } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isLegacyLog, promoteLegacySystemMessages, scanCanonicalLog, translateLegacyClaudeLog, validateCanonicalLog, type LogExpectation } from '@retaxmaster/agents-realtime-server';
import type { AgentProvider, DoneStatus } from '@retaxmaster/agents-realtime-protocol';
import { splitStoredPrompt } from './legacy-prompt-split.js';
import { makeRecognizer } from './legacy-system-recognizer.js';

/**
 * Reader 3 of the MIXED `prompt` column (spec §3.1.1). The rescue SYNTHESIZES `user.prompt` from the
 * database, so it is the one reader with no live replay to compensate — a dropped system message here is
 * undetectable, and a doubled one lands in precisely the field this feature exists to clean.
 *
 * It applies the same rule the log recognizer applies on the log side, so the two cannot drift.
 */
export function resolveRescuedTurnInput(run: {
  prompt: string | null;
  systemMessageText: string | null;
}): { systemMessage: string | null; userMessage: string } {
  const split = splitStoredPrompt(run.prompt, run.systemMessageText);
  return {
    systemMessage: run.systemMessageText ?? null,
    userMessage: split ? split.userMessage : (run.prompt ?? ''),
  };
}

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

// A run log is SECRET-GRADE: it carries the user's prompt, the agent's full output, and a stderr tail. The
// engine creates them `0600` on purpose. A rescued log must not be more readable than the log it replaces
// — and `rename` carries the TEMP file's permissions onto the target, so a temp created at the umask
// default (typically 0644) would silently publish an admin's conversation transcript to every local user.
const SECRET_GRADE_MODE = 0o600;

// Replace `path` with `content` ATOMICALLY: write to a sibling temp file on the SAME filesystem, fsync it
// durable, then rename() over the target. `rename` within one directory is atomic on every filesystem we
// run on — the original is either the OLD bytes or the NEW bytes, in full, never a truncated mix. A plain
// `writeFile(path, …)` truncates the one and only original the instant it opens the file: a crash, a full
// disk, or an I/O error mid-write leaves a half-written NDJSON and destroys BOTH the legacy original and
// the conversion, and the engine's reader is fail-closed — one bad line bricks the whole conversation.
//
// PERMISSIONS ARE PART OF THE REPLACEMENT. We preserve the ORIGINAL file's mode (a rescue must not change
// who can read a transcript, in either direction), falling back to 0600 — the engine's own, restrictive
// default — if the target's mode cannot be read. The temp is created 0600 from the very first byte, so the
// content is never briefly world-readable on disk even before the chmod.
async function atomicReplaceFile(path: string, content: string): Promise<void> {
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);

  // The mode to land on the target: the original's, or the secret-grade default. Never the umask's.
  let targetMode = SECRET_GRADE_MODE;
  try {
    targetMode = (await stat(path)).mode & 0o777;
  } catch {
    // No original (or unreadable metadata) → fail SAFE, not open.
  }

  try {
    // `mode` on writeFile only applies at CREATION, and it is masked by the umask — so we chmod explicitly
    // below rather than trust it. Creating at 0600 first means the window before the chmod is the tight
    // one, not the permissive one.
    await writeFile(tmpPath, content, { encoding: 'utf8', mode: SECRET_GRADE_MODE });
    await chmod(tmpPath, targetMode);
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

// ADOPT the log into the engine's durable index, then BACKFILL the run row — the two steps that make a
// converted log actually READABLE, wrapped so that neither can kill the batch.
//
// ADOPTION IS MANDATORY, not optional cleanup. The engine resolves logs by runId through its DURABLE INDEX,
// never by path — that invariant is what stops a host bug from serving another conversation's file. A
// converted log sitting in logRoot that was never adopted is INVISIBLE to the engine: the symptom is
// `OwnRunLogUnavailableError: no log path in the durable run index`, a 500 whose message never points back
// at this migration. (`beginRun` cannot be reused here — it creates the log with O_CREAT|O_EXCL and throws
// against a file that already exists.)
//
// THE BACKFILL is OURS, and it is on no upstream checklist. Our own all-or-nothing membership rule
// (`runsForSession` in knowledge-chat-orchestrator.ts) EXCLUDES a run whose providerSessionId is null and
// sessionTracked is false — exactly what every pre-1.0 row looks like before this write. Without it the
// rescued log is byte-perfect and adopted, and the conversation still never reads it.
//
// WHY THE TRY/CATCH: `adoptExistingLog` throws on any door-check failure, and this is a BATCH maintenance
// job. A throw that escapes the per-file loop takes every REMAINING file down with it — a single
// unforeseen bad log would silently halve a migration. Predicates can only exclude the cases we thought
// of; fault isolation holds for the ones we did not, which is why it is the more fundamental guarantee of
// the two. Failure here is also SAFE to defer: the canonical bytes are already valid on disk, so the next
// run repairs the file through the repair branch.
async function adoptAndBackfill(
  prisma: PrismaClient,
  index: LogIndex,
  entry: { runId: string; path: string; startedAtMs: number; providerSessionId: string; expect: LogExpectation },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { runId, path, startedAtMs, providerSessionId, expect } = entry;
  try {
    index.adoptExistingLog({ logPath: path, startedAtMs, expect });
    await prisma.knowledgeChatRun.update({
      where: { id: runId },
      data: { providerSessionId, sessionTracked: true },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `adoption/backfill failed (the canonical file is intact; a later re-run will repair it): ${message}` };
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
        // throw. Reported via `skipped` (not silently folded into `alreadyCanonical`) because an untracked
        // session on a genuinely-run conversation is worth an operator's attention, even though it is not
        // this script's job to fix it.
        report.skipped.push({
          runId,
          reason: 'canonical file was spawned by this engine (carries a runner identity) — not a legacy-rescue candidate; sessionTracked=false here is unrelated to the pre-1.0 migration and should be investigated separately',
        });
        continue;
      }
      // NO identity is still not enough to call this a partial rescue. The engine writes the log's
      // {header, lead} pair BEFORE it tries to start the runner, so a run that failed PRE-SPAWN (a failing
      // `onRun`, a failed spawn, an unreadable /proc identity, a missing first report) leaves a canonical,
      // TERMINAL log behind that has no `log.identity` AND no `session.started` — and migration 0017 left
      // its row at `sessionTracked = false` just like a real pre-1.0 row. A rescued log, by contrast, ALWAYS
      // carries a `session.started` (the translator synthesizes one from the session id we hand it). So the
      // positive marker of "this is rescue output" is `sawSessionStarted`, and its absence means a pre-spawn
      // engine failure — which `adoptExistingLog` rejects for having no matching `session.started`.
      if (!scan.sawSessionStarted) {
        report.skipped.push({
          runId,
          reason: 'canonical file has no session.started — this is an engine run that failed BEFORE spawning (the engine writes the header+lead pre-spawn), not a partially-rescued legacy log; nothing to adopt',
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
      const outcome = await adoptAndBackfill(prisma, index, {
        runId, path, startedAtMs: scan.header.startedAtMs, providerSessionId, expect,
      });
      if (!outcome.ok) {
        report.skipped.push({ runId, reason: outcome.reason });
        continue;
      }

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

    const turnInput = resolveRescuedTurnInput(run);

    const { canonical: translated, stats } = translateLegacyClaudeLog({
      legacy: text,
      runId,
      providerSessionId,
      // THE ORIGINAL STORED PROMPT, STILL CONCATENATED — deliberately not `turnInput.userMessage`.
      //
      // The promotion below is what SPLITS it, via the shared recognizer, and the recognizer matches the
      // CONCATENATED text. Handing the translator the already-split half makes `promoteLegacySystemMessages`
      // a guaranteed no-op: it finds nothing to claim, promotes zero turns, and the rescued log silently
      // loses the system message entirely. Measured, not reasoned about — the split half yields
      // `turnsPromoted: 0` and a log with no `systemMessage`, the concatenated one yields 1 and a log that
      // carries it. This is the reader with no live replay to compensate, so that drop would be permanent
      // and undetectable.
      userPrompt: run.prompt,
      startedAtMs,
      status: doneStatus,
      hashUnsupported: sha256,
    });

    // The translator has no systemMessage channel, so a run that consumed one gets its `turn.input` line
    // promoted through the SAME package function the live path's migration uses — never a hand-rolled
    // line, or the two would drift into different shapes for the same turn.
    //
    // AND THE RECOGNIZER IS THE SHARED ONE (`makeRecognizer`), not an inline closure: the spec requires the
    // rescue use the same builder the live path uses so the two cannot drift, and a hand-rolled
    // `recognize:` here would be a second construction of the rule `legacy-prompt-split.ts` exists to own.
    let canonical = translated;
    if (turnInput.systemMessage) {
      const promoted = promoteLegacySystemMessages(translated, {
        recognize: makeRecognizer({
          systemMessageText: run.systemMessageText,
          systemMessageState: run.systemMessageState ?? 'CONSUMED',
        }),
      });
      // FAIL LOUD RATHER THAN WRITE A LOG THAT LOST THE MESSAGE. The run row says this turn carried a
      // system message; if the recognizer claimed no turn, the rescued log would show the agent answering
      // a question it was never asked in the form it was asked. Skipping leaves the ORIGINAL legacy file
      // untouched on disk, which is retryable — writing the lossy log is not.
      if (promoted.stats.turnsPromoted === 0) {
        report.skipped.push({
          runId,
          reason:
            'run consumed a system message but the recognizer claimed no turn in its log — refusing to write a log that would drop it',
        });
        continue;
      }
      canonical = promoted.canonical;
    }

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

    // ADOPT + BACKFILL. Both steps, and their fault isolation, live in `adoptAndBackfill` — see its
    // comment. If the process dies between the write above and those steps, the file is now canonical but
    // still `sessionTracked: false` on its run row; the NEXT run of this script picks that exact state up
    // in the `!legacy` branch above and repairs it (FIX 1).
    const outcome = await adoptAndBackfill(prisma, index, {
      runId, path, startedAtMs, providerSessionId, expect,
    });
    if (!outcome.ok) {
      // The canonical bytes are already on disk and are VALID (we validated them above), so this is not a
      // loss — the next run repairs it through the `!legacy` branch. Report it and keep going.
      report.skipped.push({ runId, reason: outcome.reason });
      continue;
    }

    report.rescued.push(runId);
    // Rescued ≠ lossless. Say so when it wasn't: a line the translator could not read came back as an
    // `unsupported` placeholder, and the operator deserves to know which conversation is missing content
    // rather than reading "rescued" and assuming it is whole.
    if (stats.corrupt > 0) report.degraded.push({ runId, corrupt: stats.corrupt, linesIn: stats.linesIn });
  }

  return report;
}
