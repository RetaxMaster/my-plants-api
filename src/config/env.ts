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
  PORT: z.coerce.number().int().positive().default(3000),
  DEFAULT_CITY_TZ: z.string().min(1).default('America/Mexico_City'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('30d'),
  // Browser origin allowed by CORS (web app) — also the engine's Socket.IO corsOrigins. Homing it
  // here (main.ts historically read it straight off process.env) lets the engine derive corsOrigins
  // from the typed env.
  WEB_ORIGIN: z.string().min(1).default('http://localhost:8001'),
  // R2 image storage (spec 2026-07-02). ALL OPTIONAL: the API boots without them; only an actual
  // upload fails (typed r2_not_configured → 503, added in Phase 2). `.default('')` keeps every
  // parsed value a string so downstream code never handles `undefined`.
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ENDPOINT: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_PUBLIC_BASE_URL: z.string().default(''),

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
  KNOWLEDGE_ENGINE_CWD: z.string().min(1), // required — isolated knowledge-engine checkout
  CLAUDE_BIN: z.string().min(1).default('claude'),
  KNOWLEDGE_CHAT_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  KNOWLEDGE_CHAT_RUN_BUFFER_MS: z.coerce.number().int().positive().default(120_000),
  KNOWLEDGE_CHAT_TICKET_TTL_MS: z.coerce.number().int().positive().default(60_000),
});

export type DbEnv = z.infer<typeof dbSchema>;
export type Env = z.infer<typeof envSchema>;

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbSchema.parse(source);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
