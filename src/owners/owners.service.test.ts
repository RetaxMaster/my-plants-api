import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { ForbiddenException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { OwnersService } from './owners.service.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });

function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const prisma = {
    owner: {
      findMany: async () => [
        { id: 'o1', name: 'Owner One', user: { username: 'retax', role: 'ADMIN' } },
        { id: 'o2', name: 'Headless Owner', user: null }, // owner with no linked user
      ],
    },
  } as any;
  const svc = new OwnersService(prisma, owner);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run };
}

describe('OwnersService', () => {
  it('rejects a USER (403)', async () => {
    const { svc, run } = setup();
    await run(actor('o1', 'USER'), async () => {
      await expect(svc.list()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('lists every owner with username/role for an ADMIN, falling back to owner name when no user', async () => {
    const { svc, run } = setup();
    const out = await run(actor('o1', 'ADMIN'), () => svc.list());
    expect(out).toEqual([
      { ownerId: 'o1', username: 'retax', role: 'ADMIN' },
      { ownerId: 'o2', username: 'Headless Owner', role: null },
    ]);
  });
});
