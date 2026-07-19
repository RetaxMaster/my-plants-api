import { resolve } from 'node:path';
import { z } from 'zod';

const dbSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
});

export const envSchema = dbSchema.extend({
  // Which environment this process believes it is running in. Introduced for the QA fixture reset
  // (`npm run qa:reset`), a DESTRUCTIVE script that must never be able to run against production.
  //
  // The default is deliberately `production`, not `development`. A guard that opens when configuration
  // is MISSING is not a guard — an unconfigured prod box would sail straight past it. Fail-closed means
  // the destructive path unlocks only where someone deliberately wrote `APP_ENV=development`, and every
  // other case (typo, forgotten var, a fresh server, a stray shell) is refused.
  //
  // Nothing in the app's runtime behaviour branches on this: it exists to gate tooling, not to fork
  // product logic. Keep it that way — environment-conditional behaviour is how prod-only bugs are born.
  APP_ENV: z.enum(['development', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Network interface the HTTP server binds to. Defaults to 0.0.0.0 (all interfaces) so local dev and
  // the e2e harness keep working unchanged. In production it is pinned to 127.0.0.1 so the API is
  // reachable ONLY by the co-located web BFF (Nitro proxies to it over localhost) and never exposed to
  // the internet — the browser talks to the web app, never to this API directly.
  HOST: z.string().min(1).default('0.0.0.0'),
  DEFAULT_CITY_TZ: z.string().min(1).default('America/Mexico_City'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('30d'),
  // Hard absolute cap (days) on a session's total lifetime, measured from the FIRST login (the JWT's
  // `sst` anchor, preserved across refreshes). Once exceeded, `verify()` rejects and `/auth/refresh`
  // refuses — forcing a fresh login regardless of activity. Bounds the worst case of a leaked token.
  SESSION_ABSOLUTE_MAX_DAYS: z.coerce.number().int().positive().default(90),
  // Browser origin allowed by CORS (web app) — also the engine's Socket.IO corsOrigins. Homing it
  // here (main.ts historically read it straight off process.env) lets the engine derive corsOrigins
  // from the typed env.
  WEB_ORIGIN: z.string().min(1).default('http://localhost:8001'),
  // R2 image storage (spec 2026-07-02). ALL OPTIONAL: the API boots without them; only an actual
  // upload fails (typed r2_not_configured → 503, added in Phase 2). `.default('')` keeps every
  // parsed value a string so downstream code never handles `undefined`.
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_PUBLIC_BASE_URL: z.string().default(''),

  // Where raw uploaded bytes wait between the request and the async photo worker (spec §3.2). Staged ON DISK
  // (not in memory — memory does not survive pm2 reload). MUST end up ABSOLUTE (mirrors KNOWLEDGE_CHAT_LOG_DIR)
  // and MUST live OUTSIDE the build/deploy tree in production so a deploy never wipes in-flight bytes. Created
  // on boot if missing.
  PHOTO_INBOX_DIR: z.string().min(1).default('storage/photo-inbox').transform((v) => resolve(v)),
  // Free-space floor (MB) for the filesystem holding PHOTO_INBOX_DIR (spec §3.2 capacity guard). Staging is
  // rejected with 503 photo_storage_busy when it would drop free space below this — the direct protection
  // against ENOSPC during a sustained R2 outage. Tuned constant.
  INBOX_MIN_FREE_MB: z.coerce.number().int().positive().default(1024),

  // Knowledge-engine admin chat (spec §8): the embedded realtime engine + isolated claude cwd.
  KNOWLEDGE_CHAT_ENGINE_PORT: z.coerce.number().int().positive().default(8010),
  KNOWLEDGE_CHAT_ENGINE_SECRET: z.string().min(16), // required — gates the engine's /execute
  // Lets the full-app boot skip binding/listening (hermetic e2e / CI). Default on.
  KNOWLEDGE_CHAT_ENGINE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // MUST end up ABSOLUTE: the engine spawns `claude` with cwd = KNOWLEDGE_ENGINE_CWD (the isolated
  // checkout) and the supervisor redirects stdout/stderr to this path via a shell — a RELATIVE value
  // would resolve against the spawned shell's cwd (the checkout, which has no such dir) and the
  // redirection fails before claude runs. Resolve to absolute here so no relative env value can ever
  // reintroduce that bug, regardless of which process (API vs spawned shell) touches the path.
  KNOWLEDGE_CHAT_LOG_DIR: z.string().min(1).default('storage/knowledge-chat').transform((v) => resolve(v)),
  // The engine's DURABLE run index (runId → logPath) lives here — required by createServer since
  // agents-realtime 1.0.0. It is what lets a run survive an API restart (the engine re-adopts the
  // still-alive runner from this index), so it must be a persistent, writable, ABSOLUTE path — never
  // a tmp dir that a reboot wipes. Kept out of KNOWLEDGE_CHAT_LOG_DIR: that dir is the engine's
  // `logRoot` allow-list, and the index is not a run log.
  KNOWLEDGE_CHAT_STATE_DIR: z.string().min(1).default('storage/knowledge-chat-state').transform((v) => resolve(v)),
  KNOWLEDGE_ENGINE_CWD: z.string().min(1), // required — isolated knowledge-engine checkout
  CLAUDE_BIN: z.string().min(1).default('claude'),
  CODEX_BIN: z.string().min(1).default('codex'),
  // Codex's sandbox when it runs the knowledge engine. The default is `danger-full-access`, and it must be
  // understood for what it actually is.
  //
  // WHY: Codex's `workspace-write` sandbox disables NETWORK access, and web research is the knowledge
  // engine's entire job — under it every curation run would fail to reach a single source.
  //
  // WHAT IT REALLY COSTS (state this honestly): `cwd` is where the agent STARTS, not a boundary it is
  // confined to. Under full access the agent can read and write anything this API's Unix user can —
  // including `.env` files, the engine's own state, and the production checkout. The blast radius is the
  // PROCESS USER, not KNOWLEDGE_ENGINE_CWD. Combined with web research, prompt-injection from a fetched
  // page is a real path to that access, and "only admins can type a prompt" does not close it.
  //
  // WHY WE SHIP IT ANYWAY: Claude ALREADY runs in that same checkout, as the same Unix user, with
  // --dangerously-skip-permissions. So this grants Codex exactly the reach Claude has had all along — it
  // does not open a new door, it declines to close an existing one. The real fix is a genuine boundary
  // (a dedicated Unix user with no access to secrets or the product, or a container), which is a
  // deliberate follow-up and is tracked as such — not something a sandbox string here can fake.
  //
  // Set this to `workspace-write` (accepting the loss of network) or `read-only` to narrow it.
  KNOWLEDGE_CHAT_CODEX_SANDBOX: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('danger-full-access'),
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: z.coerce.number().int().positive().default(120_000),
  KNOWLEDGE_CHAT_TICKET_TTL_MS: z.coerce.number().int().positive().default(60_000),

  // ── Plant Doctor engine (a second agents-realtime instance in the doctor's checkout, spec §2/§6) ──
  // The doctor is a SECOND createServer() instance whose provider registry bakes PLANT_DOCTOR_ENGINE_CWD;
  // a DOCTOR session's runs execute here, isolated from the knowledge engine. It reuses CLAUDE_BIN /
  // CODEX_BIN / KNOWLEDGE_CHAT_CODEX_SANDBOX / the run+ticket timeouts / JWT_SECRET / WEB_ORIGIN.
  //
  // REQUIRED, expected already-absolute (same rationale as KNOWLEDGE_ENGINE_CWD): the spawned shell's
  // stdout/stderr redirection resolves against the spawned cwd, so a relative value silently breaks the
  // redirection before the agent runs.
  PLANT_DOCTOR_ENGINE_CWD: z.string().min(1),
  PLANT_DOCTOR_CHAT_ENGINE_PORT: z.coerce.number().int().positive().default(8400),
  PLANT_DOCTOR_CHAT_ENGINE_SECRET: z.string().min(16), // required — gates the doctor engine's /execute
  // Lets the full-app boot skip binding/listening (hermetic e2e / CI). Default on.
  PLANT_DOCTOR_ENGINE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // The doctor engine's run-log `logRoot` allow-list. MUST end up ABSOLUTE (see KNOWLEDGE_CHAT_LOG_DIR).
  PLANT_DOCTOR_LOG_DIR: z.string().min(1).default('storage/plant-doctor').transform((v) => resolve(v)),
  // The doctor engine's DURABLE run index + the codexRolesVerified record. Persistent, ABSOLUTE.
  PLANT_DOCTOR_STATE_DIR: z.string().min(1).default('storage/plant-doctor-state').transform((v) => resolve(v)),
  // Per-session isolated workspaces (each holds a doctor-context.json + scoped token). Persistent and,
  // in prod, OUTSIDE the deploy/build tree so a deploy never wipes an in-flight diagnosis. ABSOLUTE.
  PLANT_DOCTOR_WORKSPACE_ROOT: z.string().min(1).default('storage/plant-doctor-workspaces').transform((v) => resolve(v)),
  // TTL of the per-run scoped `doctor` JWT (§3.3). 30 min = one run window (matches the run timeout).
  PLANT_DOCTOR_TOKEN_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
});

export type DbEnv = z.infer<typeof dbSchema>;
export type Env = z.infer<typeof envSchema>;

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbSchema.parse(source);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
