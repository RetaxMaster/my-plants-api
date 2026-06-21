import { describe, expect, it } from 'vitest';
import { loadEnv, loadDbEnv } from './env.js';

const DB = { DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' };

describe('loadDbEnv', () => {
  it('parses DB vars without requiring JWT secrets', () => {
    const env = loadDbEnv({ ...DB } as NodeJS.ProcessEnv);
    expect(env.DB_NAME).toBe('n');
  });
});

describe('loadEnv', () => {
  it('requires JWT_SECRET (min 32 chars)', () => {
    expect(() => loadEnv({ ...DB } as NodeJS.ProcessEnv)).toThrow();
    const ok = loadEnv({ ...DB, JWT_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv);
    expect(ok.JWT_EXPIRES_IN).toBe('30d'); // default
  });
});
