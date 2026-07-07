import { describe, expect, it, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService, sessionAgeExceeded } from './auth.service.js';

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
const ENV_90 = { SESSION_ABSOLUTE_MAX_DAYS: 90 } as any;

describe('AuthService', () => {
  let svc: AuthService;
  let prisma: ReturnType<typeof makePrismaFake>;
  beforeEach(async () => {
    prisma = makePrismaFake();
    svc = new AuthService(prisma as any, jwt, ENV_90);
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

  it('login stamps an sst anchor on the token', async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await svc.login('carlos', 'secret');
    const payload = await svc.verify(r.token);
    expect(payload.sst).toBeGreaterThanOrEqual(before);
  });

  it('verify rejects a token whose session is older than the absolute cap', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await jwt.signAsync({
      sub: 'u1', username: 'carlos', ownerId: 'o1', role: 'ADMIN',
      jti: 'j-old', sst: nowSec - 100 * 86400,
    });
    await expect(svc.verify(token)).rejects.toThrow();
  });

  it('verify falls back to iat when sst is absent (legacy tokens)', () => {
    const nowSec = 1_000_000_000;
    expect(sessionAgeExceeded(nowSec - 89 * 86400, nowSec, 90)).toBe(false);
    expect(sessionAgeExceeded(nowSec - 91 * 86400, nowSec, 90)).toBe(true);
  });
});
