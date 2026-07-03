import { describe, expect, it } from 'vitest';
import { isAbsolute, resolve } from 'node:path';
import { loadEnv, loadDbEnv } from './env.js';

const DB = { DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' };
// The engine vars that have no default and must be present for loadEnv() to succeed.
const ENGINE = { KNOWLEDGE_CHAT_ENGINE_SECRET: 'x'.repeat(16), KNOWLEDGE_ENGINE_CWD: '/tmp/knowledge-engine' };
const FULL = { ...DB, JWT_SECRET: 'x'.repeat(32), ...ENGINE };

describe('loadDbEnv', () => {
  it('parses DB vars without requiring JWT secrets', () => {
    const env = loadDbEnv({ ...DB } as NodeJS.ProcessEnv);
    expect(env.DB_NAME).toBe('n');
  });
});

describe('loadEnv', () => {
  it('requires JWT_SECRET (min 32 chars)', () => {
    expect(() => loadEnv({ ...DB, ...ENGINE } as NodeJS.ProcessEnv)).toThrow();
    const ok = loadEnv({ ...FULL } as NodeJS.ProcessEnv);
    expect(ok.JWT_EXPIRES_IN).toBe('30d'); // default
  });

  it('requires KNOWLEDGE_CHAT_ENGINE_SECRET and KNOWLEDGE_ENGINE_CWD', () => {
    const { KNOWLEDGE_CHAT_ENGINE_SECRET: _s, ...noSecret } = FULL;
    const { KNOWLEDGE_ENGINE_CWD: _c, ...noCwd } = FULL;
    expect(() => loadEnv(noSecret as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadEnv(noCwd as NodeJS.ProcessEnv)).toThrow();
  });

  it('applies sensible defaults for the optional engine vars', () => {
    const env = loadEnv({ ...FULL } as NodeJS.ProcessEnv);
    expect(env.KNOWLEDGE_CHAT_ENGINE_PORT).toBe(8010);
    expect(env.KNOWLEDGE_CHAT_ENGINE_ENABLED).toBe(true);
    expect(env.KNOWLEDGE_CHAT_LOG_DIR).toBe(resolve('storage/knowledge-chat'));
    expect(env.CLAUDE_BIN).toBe('claude');
    expect(env.KNOWLEDGE_CHAT_RUN_TIMEOUT_MS).toBe(1_800_000);
    expect(env.KNOWLEDGE_CHAT_RUN_BUFFER_MS).toBe(120_000);
    expect(env.KNOWLEDGE_CHAT_TICKET_TTL_MS).toBe(60_000);
    expect(env.WEB_ORIGIN).toBe('http://localhost:8001');
  });

  it('parses KNOWLEDGE_CHAT_ENGINE_ENABLED=false as a boolean false', () => {
    const env = loadEnv({ ...FULL, KNOWLEDGE_CHAT_ENGINE_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(env.KNOWLEDGE_CHAT_ENGINE_ENABLED).toBe(false);
  });

  it('always resolves KNOWLEDGE_CHAT_LOG_DIR to an ABSOLUTE path (a relative value is a spawn-cwd bug)', () => {
    // A RELATIVE value must never survive: the engine spawns claude in the isolated checkout and
    // redirects the log via a shell, so a relative path would resolve against the wrong cwd and fail.
    const rel = loadEnv({ ...FULL, KNOWLEDGE_CHAT_LOG_DIR: 'storage/knowledge-chat' } as NodeJS.ProcessEnv);
    expect(isAbsolute(rel.KNOWLEDGE_CHAT_LOG_DIR)).toBe(true);
    expect(rel.KNOWLEDGE_CHAT_LOG_DIR).toBe(resolve('storage/knowledge-chat'));

    // An already-absolute value passes through unchanged.
    const abs = loadEnv({ ...FULL, KNOWLEDGE_CHAT_LOG_DIR: '/var/lib/myplants/kchat' } as NodeJS.ProcessEnv);
    expect(abs.KNOWLEDGE_CHAT_LOG_DIR).toBe('/var/lib/myplants/kchat');
  });
});

describe('loadEnv — R2 image storage (optional feature)', () => {
  const base = { ...FULL };

  it('defaults all five R2 vars to empty when unset (API boots without R2)', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.R2_ACCOUNT_ID).toBe('');
    expect(env.R2_ACCESS_KEY_ID).toBe('');
    expect(env.R2_SECRET_ACCESS_KEY).toBe('');
    expect(env.R2_BUCKET).toBe('');
    expect(env.R2_PUBLIC_BASE_URL).toBe('');
  });

  it('passes provided R2 vars through', () => {
    const env = loadEnv({ ...base, R2_BUCKET: 'b', R2_PUBLIC_BASE_URL: 'https://cdn.example.com/' } as NodeJS.ProcessEnv);
    expect(env.R2_BUCKET).toBe('b');
    expect(env.R2_PUBLIC_BASE_URL).toBe('https://cdn.example.com/');
  });
});
