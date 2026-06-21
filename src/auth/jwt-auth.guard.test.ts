import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const reflector = (isPublic: boolean) => ({ getAllAndOverride: () => isPublic }) as any;
const authSvc = {
  verify: async (t: string) =>
    t === 'good'
      ? { sub: 'u1', username: 'carlos', ownerId: 'o1', role: 'USER', jti: 'j', exp: 9999999999 }
      : (() => {
          throw new Error('bad');
        })(),
} as any;
const ctx = (auth?: string) =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ headers: auth ? { authorization: auth } : {} } as any) }),
  }) as any;

describe('JwtAuthGuard', () => {
  // ClsService takes an AsyncLocalStorage, NOT a Map (a Map has no .run()).
  const cls = new ClsService(new AsyncLocalStorage());

  it('allows @Public() without a token', async () => {
    const g = new JwtAuthGuard(reflector(true), authSvc, cls);
    await cls.run(async () => expect(await g.canActivate(ctx())).toBe(true));
  });

  it('rejects a missing token on a protected route', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      await expect(g.canActivate(ctx())).rejects.toThrow();
    });
  });

  it('rejects an invalid token on a protected route', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      await expect(g.canActivate(ctx('Bearer bad'))).rejects.toThrow();
    });
  });

  it('accepts a valid token and sets the actor in CLS + req.user', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const req = { headers: { authorization: 'Bearer good' } } as any;
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;
      expect(await g.canActivate(context)).toBe(true);
      expect((cls.get('actor') as any).ownerId).toBe('o1');
      expect((cls.get('actor') as any).username).toBe('carlos');
      expect(req.user.ownerId).toBe('o1');
    });
  });
});
