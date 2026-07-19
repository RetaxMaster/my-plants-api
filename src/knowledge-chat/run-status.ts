/**
 * The run statuses that count as ACTIVE — the single source of truth for "this run still holds the
 * session's active slot".
 *
 * It lives in its own module because three call sites used to keep their own copy of the list
 * (`knowledge-chat.service.ts`, `knowledge-chat-orchestrator.ts`, `doctor-session-cleanup.service.ts`).
 * Adding `LAUNCHING` to two of three would have been invisible and catastrophic in exactly one direction:
 * a LAUNCHING run omitted from a list looks IDLE, so a second turn can be admitted while the first is
 * mid-spawn, and the deploy drain stops waiting for a process that is about to exist.
 *
 * ⚠️ `LAUNCHING` is the lease state (spec §8.1): a run holding it has passed the point of no return and
 * WILL call `/execute`, but has not yet reported its pid. It is non-terminal and must be treated as active
 * everywhere.
 *
 * ⚠️ The deploy drain (phase 6) mirrors these literals in raw SQL and CANNOT import this constant — it is
 * shell + SQL, deliberately decoupled from the generated Prisma enum so it builds regardless of migration
 * order. `launch-lease.test.ts` pins the exact vocabulary so a change here fails loudly and names the
 * drain as the sibling that must be updated in the same change.
 */
export const ACTIVE_RUN_STATUSES = ['QUEUED', 'LAUNCHING', 'RUNNING'] as const;

export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
