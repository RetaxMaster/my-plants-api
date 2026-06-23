import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const reflector = (isPublic: boolean) => ({ getAllAndOverride: () => isPublic }) as any;
const authSvc = {
  verify: async (t: string) => {
    if (t === 'good') return { sub: 'u1', username: 'carlos', ownerId: 'o1', role: 'USER', jti: 'j', exp: 9999999999 };
    if (t === 'admin') return { sub: 'a1', username: 'root', ownerId: 'oAdmin', role: 'ADMIN', jti: 'j', exp: 9999999999 };
    throw new Error('bad');
  },
  ownerExists: async (id: string) => id === 'oTarget',
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

  const ctxWith = (auth: string, actAs?: string | string[]) => {
    const req = { headers: { authorization: auth, ...(actAs !== undefined ? { 'x-act-as-owner': actAs } : {}) } } as any;
    return {
      req,
      context: { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) } as any,
    };
  };

  it('an ADMIN with a valid x-act-as-owner gets actingAsOwnerId set', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const { req, context } = ctxWith('Bearer admin', 'oTarget');
      expect(await g.canActivate(context)).toBe(true);
      expect(req.user.actingAsOwnerId).toBe('oTarget');
      expect((cls.get('actor') as any).actingAsOwnerId).toBe('oTarget');
    });
  });

  it('an ADMIN acting-as an unknown owner is rejected with ForbiddenException (403)', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const { context } = ctxWith('Bearer admin', 'ghost');
      await expect(g.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('an array x-act-as-owner is ignored for an ADMIN (not a single string)', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const { req, context } = ctxWith('Bearer admin', ['oTarget']);
      expect(await g.canActivate(context)).toBe(true);
      expect(req.user.actingAsOwnerId).toBeUndefined();
    });
  });

  it('a USER cannot impersonate: x-act-as-owner is ignored', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const { req, context } = ctxWith('Bearer good', 'oTarget');
      expect(await g.canActivate(context)).toBe(true);
      expect(req.user.actingAsOwnerId).toBeUndefined();
    });
  });

  it('an empty / whitespace x-act-as-owner is ignored for an ADMIN', async () => {
    const g = new JwtAuthGuard(reflector(false), authSvc, cls);
    await cls.run(async () => {
      const { req, context } = ctxWith('Bearer admin', '   ');
      expect(await g.canActivate(context)).toBe(true);
      expect(req.user.actingAsOwnerId).toBeUndefined();
    });
  });
});
