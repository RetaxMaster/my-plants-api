import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { LoginDto } from './login.dto.js';

// The global ValidationPipe (whitelist + transform) turns any validation error here into a 400,
// so these assertions pin the exact behavior that replaces the old `username: undefined` → Prisma
// 500 on a malformed login.
describe('LoginDto', () => {
  const errorsFor = (payload: unknown) => validate(plainToInstance(LoginDto, payload));

  it('rejects a missing username (the 500-causing case)', async () => {
    const errs = await errorsFor({ password: 'secret' });
    expect(errs.some((e) => e.property === 'username')).toBe(true);
  });

  it('rejects an empty username and password', async () => {
    const errs = await errorsFor({ username: '', password: '' });
    expect(errs.map((e) => e.property).sort()).toEqual(['password', 'username']);
  });

  it('rejects a non-string username', async () => {
    const errs = await errorsFor({ username: 123, password: 'secret' });
    expect(errs.some((e) => e.property === 'username')).toBe(true);
  });

  it('accepts a well-formed payload', async () => {
    const errs = await errorsFor({ username: 'alice', password: 'secret' });
    expect(errs).toHaveLength(0);
  });
});
