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

describe('loadEnv — R2 image storage (optional feature)', () => {
  const base = {
    DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n',
    JWT_SECRET: 'x'.repeat(32),
  };

  it('defaults all six R2 vars to empty when unset (API boots without R2)', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.R2_ACCOUNT_ID).toBe('');
    expect(env.R2_ENDPOINT).toBe('');
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
