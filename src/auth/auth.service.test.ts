import { describe, expect, it, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';

function makePrismaFake() {
  const revoked = new Map<string, { jti: string; expiresAt: Date }>();
  return {
    revoked,
    user: { findUnique: async ({ where }: any) => (globalThis as any).__user?.username === where.username ? (globalThis as any).__user : null },
    owner: { findUnique: async ({ where }: any) => (where.id === 'o1' ? { id: 'o1' } : null) },
    revokedToken: {
      findUnique: async ({ where }: any) => revoked.get(where.jti) ?? null,
      create: async ({ data }: any) => { revoked.set(data.jti, data); return data; },
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

const jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '30d' } });

describe('AuthService', () => {
  let svc: AuthService;
  let prisma: ReturnType<typeof makePrismaFake>;
  beforeEach(async () => {
    prisma = makePrismaFake();
    svc = new AuthService(prisma as any, jwt);
    (globalThis as any).__user = {
      id: 'u1', username: 'carlos', role: 'ADMIN', ownerId: 'o1',
      passwordHash: await bcrypt.hash('secret', 10),
    };
  });

  it('login returns a token + user for correct credentials', async () => {
    const r = await svc.login('carlos', 'secret');
    expect(r.user).toEqual({ username: 'carlos', ownerId: 'o1', role: 'ADMIN' });
    const payload = await svc.verify(r.token);
    expect(payload.sub).toBe('u1');
    expect(payload.ownerId).toBe('o1');
    expect(payload.role).toBe('ADMIN');
    expect(payload.jti).toBeTruthy();
  });

  it('login rejects a wrong password', async () => {
    await expect(svc.login('carlos', 'nope')).rejects.toThrow();
  });

  it('login rejects an unknown user', async () => {
    await expect(svc.login('ghost', 'secret')).rejects.toThrow();
  });

  it('verify rejects a revoked token', async () => {
    const r = await svc.login('carlos', 'secret');
    const payload = await svc.verify(r.token);
    await svc.logout(payload.jti, payload.exp);
    await expect(svc.verify(r.token)).rejects.toThrow();
  });

  it('ownerExists returns true for a known owner and false otherwise', async () => {
    expect(await svc.ownerExists('o1')).toBe(true);
    expect(await svc.ownerExists('nope')).toBe(false);
  });
});
