// Spec §3.4, Task 24 — the survey-first legacy system-message promotion.
//
// `turnsPromoted: 0` is ALSO the success criterion for a re-run (the package skips a turn already followed
// by a `turn.input`), so a survey — not a bare "did this run before?" flag — is the only way to tell
// "already applied" apart from "there was never anything to apply". This script therefore ALWAYS surveys
// first and only ever writes when both (a) the survey found something AND (b) `--apply` was passed.
import '../src/config/load-env-file.js';
import { readdir, readFile, cp, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { scanCanonicalLog } from '@retaxmaster/agents-realtime-server';
import { loadEnv } from '../src/config/env.js';
import { surveyLogRoots, promoteSurveyedMatches, type Survey } from '../src/knowledge-chat/promote-legacy-system-messages.core.js';
import { atomicReplaceFile } from '../src/knowledge-chat/legacy-log-rescue.core.js';
import { acquireEngineLock } from './lib/acquire-engine-port-lock.js';

// The structural rescue rule (Correction 2 over the plan): rescued-ness is not a DB fact. A rescued/
// translated log is a pure function over legacy text, so it never carries a `log.identity` line (only the
// runner writes one for its own re-adoption); the translator always synthesizes a `session.started`. So
// "no identity, but a session.started" is the positive, structural marker of rescue output — see
// legacy-log-rescue.core.ts (around its `scanCanonicalLog`/`sawIdentity`/`sawSessionStarted` usage) for the
// full reasoning this mirrors.
function isRescuedLog(text: string): boolean {
  const scan = scanCanonicalLog(text);
  return scan.ok && !scan.sawIdentity && scan.sawSessionStarted;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

// The backup is the ONLY rollback net once files start getting rewritten below — a bare `cp` gives zero
// signal if it silently under-copies, and by the time the operator actually needs the backup, the sole
// other copy has already been overwritten. So this is a COPY-THEN-VERIFY: every source file must exist at
// its destination counterpart with a MATCHING CONTENT HASH (not just a size — the corpus here is tiny
// NDJSON transcripts, so a full hash costs nothing and catches a same-size corruption a size check would
// miss), and the file COUNT must match too (catching a silently dropped file a per-file loop alone would
// never notice). Any mismatch throws BEFORE `promoteSurveyedMatches` ever reaches the write loop — this
// runs for every root before any file is rewritten.
async function backupLogDir(root: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(process.cwd(), 'storage', 'promote-legacy-system-messages-backups', stamp, basename(root));
  await mkdir(dirname(dest), { recursive: true });
  await cp(root, dest, { recursive: true });

  const sourceFiles = await listFilesRecursive(root);
  for (const file of sourceFiles) {
    const rel = relative(root, file);
    const destFile = join(dest, rel);
    const destStat = await stat(destFile).catch(() => null);
    if (!destStat) {
      throw new Error(
        `Backup verification FAILED: ${destFile} is missing from the backup of ${root} -> ${dest}. ` +
        `Refusing to proceed — no file has been rewritten.`,
      );
    }
    const [sourceHash, destHash] = await Promise.all([sha256OfFile(file), sha256OfFile(destFile)]);
    if (sourceHash !== destHash) {
      throw new Error(
        `Backup verification FAILED: ${destFile} content hash does not match its source ${file} ` +
        `(backup of ${root} -> ${dest}). Refusing to proceed — no file has been rewritten.`,
      );
    }
  }
  const destFileCount = (await listFilesRecursive(dest)).length;
  if (destFileCount !== sourceFiles.length) {
    throw new Error(
      `Backup verification FAILED: source ${root} has ${sourceFiles.length} file(s) but backup ${dest} has ` +
      `${destFileCount} — refusing to proceed. No file has been rewritten.`,
    );
  }

  return dest;
}

function printSurvey(survey: Survey, logRoots: string[]): void {
  console.log(`Scanned ${survey.filesScanned} .ndjson file(s) across ${logRoots.length} log root(s):`);
  for (const r of survey.perRoot) {
    console.log(`  ${r.root}: ${r.filesScanned} scanned, ${r.matches} promotable, ${r.rescuedMatches} rescued`);
  }
  console.log(
    `Total: ${survey.totalMatches} promotable file(s) across the corpus, ${survey.rescuedMatches} of which ` +
    `are in RESCUED logs (the highest-yield subset — where a match is actually plausible).`,
  );
  if (survey.skipped.length > 0) {
    console.warn(`WARN: ${survey.skipped.length} file(s) promoted a turn in memory but were REFUSED (not applied):`);
    for (const s of survey.skipped) {
      console.warn(`  ${s.path}: ${s.reason}`);
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const env = loadEnv();
  const logRoots = [env.KNOWLEDGE_CHAT_LOG_DIR, env.PLANT_DOCTOR_LOG_DIR];

  const prisma = new PrismaClient();
  try {
    const survey = await surveyLogRoots({
      logRoots,
      readDir: (root) => readdir(root),
      readFile: (path) => readFile(path, 'utf8'),
      loadRun: async (runId) => {
        const run = await prisma.knowledgeChatRun.findUnique({
          where: { id: runId },
          select: { systemMessageText: true, systemMessageState: true },
        });
        // No matching row (an orphaned or foreign log) is not this migration's business: the recognizer
        // built from nulls refuses every turn, which is exactly "leave this file alone".
        return {
          systemMessageText: run?.systemMessageText ?? null,
          systemMessageState: run?.systemMessageState ?? null,
        };
      },
      isRescuedLog,
    });

    printSurvey(survey, logRoots);

    if (survey.totalMatches === 0) {
      console.log(
        'Nothing to promote. This is the EXPECTED production result (spec §3.4) — an honest zero, not a ' +
        'failure. No engine stop, no backup, no file rewritten.',
      );
      return;
    }

    if (!apply) {
      console.log('Re-run with --apply to promote the match(es) above. Nothing was written.');
      return;
    }

    const releases: Array<() => Promise<void>> = [];
    try {
      await promoteSurveyedMatches(survey, {
        stopApi: async () => {
          const lock = await acquireEngineLock(
            env.PORT,
            'the API is up. The API must be stopped for the duration — a live API can admit a run that ' +
            'appends to the very log this pass is about to rewrite.',
          );
          releases.push(lock.release);
        },
        stopEngines: async () => {
          const knowledgeLock = await acquireEngineLock(
            env.KNOWLEDGE_CHAT_ENGINE_PORT,
            'the knowledge-chat engine is up.',
          );
          releases.push(knowledgeLock.release);
          const doctorLock = await acquireEngineLock(
            env.PLANT_DOCTOR_CHAT_ENGINE_PORT,
            'the Plant Doctor engine is up.',
          );
          releases.push(doctorLock.release);
        },
        backup: async (root) => {
          const dest = await backupLogDir(root);
          console.log(`Backed up ${root} -> ${dest}`);
        },
        writeFile: async (path, content) => {
          await atomicReplaceFile(path, content);
          // Mirrors the "Backed up ... -> ..." line above: an operator recovering from a crashed --apply
          // in production has no other way to tell which files were already rewritten before the crash.
          console.log(`Promoted ${path}`);
        },
      });
      console.log(`Promoted ${survey.totalMatches} file(s).`);
    } finally {
      // Release in reverse acquisition order; nothing may reopen these ports until every write above landed.
      for (const release of releases.reverse()) await release();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
