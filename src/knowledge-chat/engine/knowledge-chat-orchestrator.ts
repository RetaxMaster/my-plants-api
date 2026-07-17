import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import type { Orchestrator, ActiveRun, OwnRunLocator, RunLogResolver } from '@retaxmaster/agents-realtime-server';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { EngineParams } from './engine-params.js';
import { KnowledgeChatTicketService } from './knowledge-chat-ticket.service.js';

const ACTIVE = ['QUEUED', 'RUNNING'] as const;

// The env-var NAMES an operator checks when a spawn fails, per engine. Naming the DOCTOR's own keys (not the
// KE's) in a doctor spawn-failure diagnostic is the whole reason the orchestrator is now params-driven.
const ENGINE_ENV_NAMES = {
  KNOWLEDGE: { cwd: 'KNOWLEDGE_ENGINE_CWD', log: 'KNOWLEDGE_CHAT_LOG_DIR', state: 'KNOWLEDGE_CHAT_STATE_DIR' },
  DOCTOR: { cwd: 'PLANT_DOCTOR_ENGINE_CWD', log: 'PLANT_DOCTOR_LOG_DIR', state: 'PLANT_DOCTOR_STATE_DIR' },
} as const;

// The seams the embedded engine uses to reach the host — implemented in-process against Prisma
// (retaxmaster's Node↔Laravel HTTP callback layer disappears). No network, no retry: direct DB writes.
//
// It also implements OwnRunLocator: the engine keys its logs by runId and has no idea which conversation
// they belonged to — we do. Handing it run IDENTITY (never a path) is what lets the engine rebuild a
// reopened conversation from ITS OWN canonical logs, so a restored transcript keeps the rich tool cards
// and diffs the live stream produced instead of degrading to plain text.
@Injectable()
export class KnowledgeChatOrchestrator implements Orchestrator, OwnRunLocator {
  private readonly logger = new Logger(KnowledgeChatOrchestrator.name);

  // Param-driven so ONE orchestrator class serves BOTH engines: `params.kind` isolates this engine's runs
  // (a DOCTOR run is invisible to the KNOWLEDGE orchestrator and vice-versa) and `params.logDir`/`stateDir`
  // point at THIS engine's directories (reuse-not-fork, Spec 3 §2).
  constructor(
    private readonly params: EngineParams,
    private readonly prisma: PrismaService,
    private readonly tickets: KnowledgeChatTicketService,
  ) {}

  validateTicket(ticket: string): Promise<{ runId: string } | null> {
    return this.tickets.consume(ticket);
  }

  // Called TWICE per run (spec §3.2): first with sessionId=null at spawn, then with the real UUID
  // once it appears in the stream. Idempotent — stamps startedAt/providerSessionId only the first time,
  // and only touches a run that is still active (a late call never resurrects a terminal run).
  async runStarted(runId: string, info: { pid: number; procStartTime: string; sessionId: string | null }): Promise<void> {
    const run = await this.prisma.knowledgeChatRun.findUnique({ where: { id: runId } });
    if (!run) return;
    await this.prisma.knowledgeChatRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE] } },
      data: {
        status: 'RUNNING',
        pid: info.pid,
        procStartTime: info.procStartTime,
        startedAt: run.startedAt ?? new Date(), // idempotent: keep the first wall-clock start
      },
    });
    if (info.sessionId) {
      // Record on the RUN which agent session it took part in. This is a plain fact about the run — not a
      // claim about the conversation — and it is what later lets history membership be answered exactly:
      // a run belongs to a conversation's memory iff it names that conversation's agent session. A run that
      // never reached the agent keeps NULL and is correctly excluded.
      await this.prisma.knowledgeChatRun.updateMany({
        where: { id: runId, providerSessionId: null },
        data: { providerSessionId: info.sessionId },
      });

      // SEAL the conversation to its agent — in ONE conditional statement. Three properties, all
      // enforced by the where-clause rather than by anything we check beforehand:
      //
      // 1. `pendingRunId: runId` — only the run that still HOLDS the claim may seal. A conversation whose
      //    opening turn never reached an agent can be retried on a different agent, and the abandoned run
      //    may still report its `session.started` afterwards. Reading "am I the newest run?" and then
      //    writing is a TOCTOU: the old run can pass that check and seal a conversation the retry already
      //    owns, pinning it to the agent the user just walked away from. Claiming a run REPLACES
      //    pendingRunId, so a superseded run's write matches zero rows — the race has no window to lose.
      //
      // 2. `providerSessionId: null` — the first seal wins; a later or repeated report never clobbers it.
      //
      // 3. `provider` and `providerSessionId` are written TOGETHER, from the SAME run, so the pair can
      //    never describe two different agents (a row claiming Codex while holding a Claude memory). The
      //    run carries the agent it was launched with precisely so this write is self-consistent.
      await this.prisma.knowledgeChatSession.updateMany({
        where: { id: run.sessionId, providerSessionId: null, pendingRunId: runId },
        data: { providerSessionId: info.sessionId, provider: run.provider },
      });
    }
  }

  // Single-winner terminal claim. status: stopped→CANCELLED; exit 0→SUCCEEDED; else FAILED.
  // The atomic updateMany over active statuses means a competing finalizer (engine `done` vs a boot
  // reconcile) elects exactly one — 0 rows affected → someone already finalized → bail. Clearing
  // `activeKey` to null is what frees the session's single-active-run slot (the @@unique constraint).
  async runFinished(runId: string, info: { exitCode: number; stopped: boolean; stderrTail: string | null }): Promise<void> {
    const status = info.stopped ? 'CANCELLED' : info.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
    // Observability: a FAILED run must never be reduced to a bare error with nothing actionable. When
    // the engine captured a stderr tail we persist it; when it is ABSENT the agent process died before
    // it said anything, so we synthesize a diagnostic naming the likely causes and the knobs to check —
    // the run's `error` alone must be enough to debug a spawn failure.
    const names = ENGINE_ENV_NAMES[this.params.kind];
    const error =
      status !== 'FAILED'
        ? null
        : info.stderrTail && info.stderrTail.trim()
          ? info.stderrTail.slice(0, 1000)
          : `The agent exited ${info.exitCode} with no stderr captured — likely a spawn failure. Check that ` +
            `the agent binary is installed and on PATH (CLAUDE_BIN / CODEX_BIN) and authenticated, that ` +
            `${names.cwd} exists, and that ${names.log} (the engine's logRoot) and ` +
            `${names.state} are absolute, writable directories.`;
    const { count } = await this.prisma.knowledgeChatRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE] } },
      data: {
        status,
        exitCode: info.exitCode,
        pid: null,
        finishedAt: new Date(),
        error,
        activeKey: null, // terminal → release the unique active slot
      },
    });
    // Log at the appropriate level (secret-safe: we log the exit code + whether stderr was present, not
    // its content). count===0 means someone already finalized (single-winner) — nothing to report.
    if (count > 0 && status === 'FAILED') {
      this.logger.warn(
        `Knowledge-chat run ${runId} FAILED (exitCode=${info.exitCode}, stderr ${info.stderrTail?.trim() ? 'captured' : 'ABSENT'}).`,
      );
    }
  }

  // Late-bound because of a construction cycle: the engine is built FROM this orchestrator, so its run
  // index cannot exist yet when this class is constructed. The engine service injects it right after
  // createServer(). Absent → we claim no own runs (every session restores through the agent's own native
  // transcript), which is the safe direction: best-effort history, never a broken read.
  private runLogResolver: RunLogResolver | null = null;

  setRunLogResolver(resolver: RunLogResolver): void {
    this.runLogResolver = resolver;
  }

  // OwnRunLocator (spec 5 §4): which runs WE executed for an agent session, oldest→newest, by identity
  // and order only — never a path (the engine resolves runId → logPath through its own durable index, so
  // a bug here can never make it read the wrong file).
  //
  // TERMINAL runs only. A still-active run is being streamed live over the socket, which replays its log
  // from offset 0; handing it to the history authority too would render that turn TWICE — once seeded
  // (truncated, since the log is still being written) and once streamed. History is the settled past; the
  // socket owns the present.
  //
  // ALL-OR-NOTHING on resolvability, and this is the subtle part. Runs predating the agents-realtime 1.0.0
  // upgrade exist in OUR database but NOT in the engine's durable run index (that index did not exist
  // before 1.0.0), so the engine cannot resolve their logs. The package treats whatever we return as the
  // COMPLETE set of our runs and reconstructs the conversation from exactly those — it only falls back to
  // the agent's own native transcript when we claim NOTHING. So returning a PARTIAL list is the worst of
  // both worlds: a conversation with old runs plus one new run would come back containing only the new
  // turn, with the older ones silently missing and no error anywhere. Claiming none instead sends the whole
  // conversation down the native path, where the agent's own transcript still holds every turn.
  //
  // Hence: if we cannot resolve EVERY settled run, we claim NONE. Complete, or external — never partial.
  async runsForSession(
    provider: AgentProvider,
    providerSessionId: string,
  ): Promise<Array<{ runId: string; startedAtMs: number }>> {
    const session = await this.prisma.knowledgeChatSession.findUnique({
      where: { providerSessionId },
      include: { runs: { orderBy: { createdAt: 'asc' } } },
    });
    // Belt and braces: providerSessionId is globally unique, but a row whose provider disagrees with the
    // one being asked about is not ours to answer for.
    if (!session || session.provider !== provider) return [];
    const resolver = this.runLogResolver;
    if (!resolver) return [];

    const settled = session.runs.filter(
      (r) => !(ACTIVE as readonly string[]).includes(r.status) && r.startedAt !== null,
    );

    // MEMBERSHIP is a fact, not an inference: a run is part of this conversation's memory iff it names this
    // conversation's agent session. Anything else is not ours to hand over.
    const members = settled.filter(
      (r) => r.provider === provider && r.providerSessionId === providerSessionId,
    );

    // An ORPHAN is a run we can PROVE never reached the agent (cancelled or killed before it opened a
    // session): it names no session, and it contributed NOTHING to the agent's memory. Excluding it loses
    // nothing — the agent never saw it — so it must NOT trigger the fallback below. This is exactly the run
    // a retried opening turn leaves behind, and claiming it used to make the engine fail the ENTIRE history
    // read (its log holds no session), which silently bricked the conversation's transcript for good.
    //
    // `sessionTracked` is what makes it a PROOF instead of a guess. A run from before we recorded that fact
    // is ALSO null here, but its null means "unknown", not "never happened" — it may well have reached the
    // agent. Such a run is deliberately NOT an orphan: it falls through to the completeness check below and
    // sends the whole conversation to the agent's own transcript, where its turn still exists.
    const orphans = settled.filter(
      (r) => r.sessionTracked && r.providerSessionId === null && resolver.resolveLogPath(r.id) !== null,
    );

    // Anything neither a member nor an orphan is a turn that DID reach an agent but that we cannot serve
    // from our own logs — a pre-1.0.0 run (absent from the engine's durable index), or one belonging to a
    // different agent session. Handing back a partial set would rebuild the conversation with those turns
    // silently missing, because the package treats our answer as COMPLETE and only falls back to the agent's
    // own transcript when we claim nothing at all. So: complete, or external — never partial.
    if (members.length + orphans.length !== settled.length) return [];
    if (members.some((r) => resolver.resolveLogPath(r.id) === null)) return [];

    // A REFUSED COMMAND is a member too — and it is the one turn the rules above cannot see.
    //
    // The engine refuses a command like `/clear` BEFORE it spawns anything: no runner, no agent session, no
    // `startedAt`. What it does produce is a real, completed run with a complete canonical log carrying the
    // `command.rejected` line and its reason. Every filter above misses it: `settled` requires a `startedAt`,
    // and membership is keyed on naming this conversation's agent session — which a refusal, by construction,
    // never does.
    //
    // Dropping it is not a cosmetic loss. The refusal is written INTO THE LOG precisely so it survives a
    // reload — a toast dies, a logged run does not — and a user who reopens the conversation tomorrow is still
    // owed the answer to "why didn't /clear work?". Excluding it silently deleted the only place that answer
    // lives.
    //
    // It cannot be confused with an orphan or a failed launch: it has a command name, it reached a terminal
    // state, and its log EXISTS in the durable index (a launch that failed before the engine accepted the run
    // has no log at all, so `resolveLogPath` returns null and it is excluded here). It is ordered by
    // `createdAt` because it has no `startedAt` — it never started; it was refused.
    const refusedCommands = session.runs.filter(
      (r) =>
        !(ACTIVE as readonly string[]).includes(r.status) &&
        r.startedAt === null &&
        r.commandName !== null &&
        r.providerSessionId === null &&
        resolver.resolveLogPath(r.id) !== null,
    );

    return [
      ...members.map((r) => ({ runId: r.id, startedAtMs: r.startedAt!.getTime() })),
      ...refusedCommands.map((r) => ({ runId: r.id, startedAtMs: r.createdAt.getTime() })),
    ].sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  // Boot re-adoption: still-RUNNING children survive a NestJS restart (spawned under setsid). Return
  // only rows with the identity the engine needs (pid/procStartTime/startedAt); a QUEUED row has no
  // pid so it is naturally excluded. startedAtMs re-arms the ORIGINAL deadline (never Date.now()).
  async activeRuns(): Promise<ActiveRun[]> {
    const runs = await this.prisma.knowledgeChatRun.findMany({
      where: {
        status: 'RUNNING',
        pid: { not: null },
        procStartTime: { not: null },
        startedAt: { not: null },
        // Only THIS engine's runs: a DOCTOR run must never be re-adopted by the KNOWLEDGE engine (which
        // would resolve its log under the wrong dir and stream it on the wrong socket) — Spec 3 §2 isolation.
        session: { is: { kind: this.params.kind } },
      },
      include: { session: true },
    });

    // REPAIR THE SEAL CLAIM for any run that spans a restart. A run launched by the PREVIOUS process can be
    // alive across a deploy — including one created after migration 0015 backfilled `pending_run_id` but
    // before this process took over — and such a run holds no claim. It would be re-adopted and stream
    // normally, yet its `session.started` could never seal its conversation, leaving it permanently
    // "unsealed": the picker unlocked, and every later turn treated as a retry of the opening one.
    //
    // A live run IS its conversation's current attempt, by definition — and the @@unique([sessionId,
    // activeKey]) constraint means there can only be one — so restoring the claim here is unambiguous.
    for (const r of runs) {
      if (r.session.pendingRunId !== r.id) {
        await this.prisma.knowledgeChatSession.update({
          where: { id: r.sessionId },
          data: { pendingRunId: r.id },
        });
      }
    }

    return runs.map((r) => ({
      runId: r.id,
      logPath: join(this.params.logDir, `${r.id}.ndjson`),
      pid: r.pid!,
      procStartTime: r.procStartTime!,
      startedAtMs: r.startedAt!.getTime(),
      sessionId: r.session.providerSessionId,
    }));
  }
}
