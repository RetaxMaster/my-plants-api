import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isLegacyLog, translateLegacyClaudeLog, validateCanonicalLog, type LogExpectation } from '@retaxmaster/agents-realtime-server';
import type { AgentProvider, DoneStatus } from '@retaxmaster/agents-realtime-protocol';

export interface LogIndex {
  adoptExistingLog(entry: { logPath: string; startedAtMs: number; expect: LogExpectation }): void;
}

export interface RescueReport {
  rescued: string[];
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

// Rescue every pre-1.0 (raw Claude stream-json, no header) `.ndjson` log under `logDir`. Filenames are
// `<runId>.ndjson` — the run row is our source of truth for everything the legacy file itself never
// recorded (the user prompt, the terminal, the real agent session id).
//
// The order is load-bearing (see the header comment of the caller / the migration plan): isLegacyLog →
// translate → validate → write → adopt → backfill the run row. Each step below is commented with WHY it
// cannot be skipped or reordered — a future "simplification" that drops one of them silently reintroduces
// the exact failure mode this migration exists to fix.
export async function rescueLegacyLogs(prisma: PrismaClient, logDir: string, index: LogIndex): Promise<RescueReport> {
  const report: RescueReport = { rescued: [], skipped: [], alreadyCanonical: 0, degraded: [] };

  const entries = await readdir(logDir);
  const ndjsonFiles = entries.filter((f) => f.endsWith('.ndjson'));
  if (ndjsonFiles.length === 0) return report;

  // isLegacyLog FIRST, before any DB round-trip. This is what makes the whole command idempotent: a file
  // already in canonical form (rescued on a previous run, or never legacy to begin with) is counted and
  // left completely alone — never re-read against the DB, never re-translated, never re-adopted.
  const legacyFiles: { runId: string; path: string; text: string }[] = [];
  for (const file of ndjsonFiles) {
    const path = join(logDir, file);
    const text = await readFile(path, 'utf8');
    if (!isLegacyLog(text)) {
      report.alreadyCanonical++;
      continue;
    }
    legacyFiles.push({ runId: basename(file, '.ndjson'), path, text });
  }
  if (legacyFiles.length === 0) return report;

  const runIds = legacyFiles.map((f) => f.runId);
  const runs = await prisma.knowledgeChatRun.findMany({
    where: { id: { in: runIds } },
    include: { session: true },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));

  for (const { runId, path, text } of legacyFiles) {
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

    await writeFile(path, canonical, 'utf8');

    // ADOPTION IS MANDATORY, not optional cleanup. The engine resolves logs by runId through its DURABLE
    // INDEX, never by path — that invariant is what stops a host bug from serving another conversation's
    // file. A converted log sitting in logRoot that was never adopted is INVISIBLE to the engine: the
    // symptom is `OwnRunLogUnavailableError: no log path in the durable run index`, a 500 whose message
    // never points back at this migration. `beginRun` cannot be reused here — it creates the log with
    // O_CREAT|O_EXCL and throws against a file that already exists.
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
