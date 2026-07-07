import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller.js';

describe('AuthController.me', () => {
  const ctrl = new AuthController({} as any);

  it('reports actingAs: null when not impersonating', () => {
    const req = { user: { username: 'carlos', role: 'USER' } } as any;
    expect(ctrl.me(req)).toEqual({ username: 'carlos', role: 'USER', actingAs: null });
  });

  it('reports the acting-as ownerId when impersonating', () => {
    const req = { user: { username: 'root', role: 'ADMIN', actingAsOwnerId: 'oTarget' } } as any;
    expect(ctrl.me(req)).toEqual({ username: 'root', role: 'ADMIN', actingAs: { ownerId: 'oTarget' } });
  });
});

describe('AuthController.refresh', () => {
  it('delegates to auth.refresh with the actor fields and returns its token', async () => {
    let seen: any;
    const auth = { refresh: async (a: any) => { seen = a; return { token: 't-new' }; } } as any;
    const ctrl = new AuthController(auth);
    const req = {
      user: { userId: 'u1', username: 'carlos', ownerId: 'o1', role: 'ADMIN', jti: 'j', sst: 1700000000, exp: 9999999999 },
    } as any;
    expect(await ctrl.refresh(req)).toEqual({ token: 't-new' });
    expect(seen).toEqual({
      userId: 'u1', username: 'carlos', ownerId: 'o1', role: 'ADMIN', jti: 'j', sst: 1700000000, exp: 9999999999,
    });
  });

  it('throws UnauthorizedException when there is no actor', async () => {
    const ctrl = new AuthController({ refresh: async () => ({ token: 'x' }) } as any);
    await expect(ctrl.refresh({} as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
