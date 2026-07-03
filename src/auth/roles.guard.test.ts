import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { RolesGuard } from './roles.guard.js';
import type { AppRole } from './roles.decorator.js';

const actor = (role: AppRole, extra: Record<string, unknown> = {}) => ({
  userId: 'u', username: 'n', ownerId: 'o', role, jti: 'j', exp: 9e9, ...extra,
});

// Minimal ExecutionContext — RolesGuard only calls getHandler()/getClass() (routed to the fake
// Reflector) and never touches the HTTP request (it reads the actor from CLS via OwnerService).
const ctx = { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;

function setup(required: AppRole[] | undefined) {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const reflector = { getAllAndOverride: () => required } as any;
  const guard = new RolesGuard(reflector, owner);
  const run = <T>(a: unknown, fn: () => Promise<T> | T) =>
    cls.run(async () => { cls.set('actor', a); return fn(); });
  return { guard, run };
}

describe('RolesGuard', () => {
  it('allows when no @Roles metadata is present (guard only enforces where applied)', async () => {
    const { guard, run } = setup(undefined);
    expect(await run(actor('USER'), () => guard.canActivate(ctx))).toBe(true);
  });

  it('allows an ADMIN when ADMIN is required', async () => {
    const { guard, run } = setup(['ADMIN']);
    expect(await run(actor('ADMIN'), () => guard.canActivate(ctx))).toBe(true);
  });

  it('rejects a USER when ADMIN is required (403)', async () => {
    const { guard, run } = setup(['ADMIN']);
    await expect(run(actor('USER'), () => guard.canActivate(ctx))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates on the REAL token role — an ADMIN acting-as another owner is still ADMIN', async () => {
    const { guard, run } = setup(['ADMIN']);
    expect(await run(actor('ADMIN', { actingAsOwnerId: 'other-owner' }), () => guard.canActivate(ctx))).toBe(true);
  });

  it('rejects when there is no authenticated actor (401)', async () => {
    const { guard, run } = setup(['ADMIN']);
    await expect(run(null, () => guard.canActivate(ctx))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
