import { describe, expect, it } from 'vitest';
import { parseArgs, createUser } from './create-user.core.js';

describe('parseArgs', () => {
  it('parses username/password/role', () => {
    const a = parseArgs(['--username', 'carlos', '--password', 'secret123', '--role', 'admin']);
    expect(a).toEqual({ username: 'carlos', password: 'secret123', role: 'ADMIN' });
  });
  it('defaults role to USER', () => {
    const a = parseArgs(['--username', 'u', '--password', 'pwpwpwpw']);
    expect(a.role).toBe('USER');
  });
  it('rejects a short password and missing username', () => {
    expect(() => parseArgs(['--username', 'u', '--password', 'short'])).toThrow();
    expect(() => parseArgs(['--password', 'longenoughpw'])).toThrow();
  });
});

describe('createUser', () => {
  it('hashes the password and creates owner+user (fresh)', async () => {
    const created: any = {};
    const prisma = {
      user: { findUnique: async () => null },
      $transaction: async (fn: any) => fn({
        owner: { create: async ({ data }: any) => { created.owner = data; return { id: 'o1', ...data }; } },
        user: { create: async ({ data }: any) => { created.user = data; return data; } },
      }),
    } as any;
    const r = await createUser(prisma, { username: 'carlos', password: 'secret123', role: 'ADMIN' });
    expect(r.username).toBe('carlos');
    expect(created.user.passwordHash).not.toBe('secret123'); // hashed
    expect(created.user.role).toBe('ADMIN');
  });

  it('rejects a duplicate username', async () => {
    const prisma = { user: { findUnique: async () => ({ id: 'x' }) } } as any;
    await expect(createUser(prisma, { username: 'carlos', password: 'secret123', role: 'USER' })).rejects.toThrow();
  });
});
