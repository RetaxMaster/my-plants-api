import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from './owner.service.js';

function withActor<T>(cls: ClsService, actor: any, fn: () => T): Promise<T> {
  return cls.run(async () => {
    cls.set('actor', actor);
    return fn();
  });
}

describe('OwnerService (actor-aware)', () => {
  // ClsService takes an AsyncLocalStorage, NOT a Map (a Map has no .run()).
  const cls = new ClsService(new AsyncLocalStorage());
  const svc = new OwnerService(cls);

  it('currentOwnerId returns the actor ownerId', async () => {
    await withActor(cls, { ownerId: 'o1', role: 'USER' }, () => {
      expect(svc.currentOwnerId()).toBe('o1');
    });
  });

  it('currentRole returns the actor role', async () => {
    await withActor(cls, { ownerId: 'o1', role: 'ADMIN' }, () => {
      expect(svc.currentRole()).toBe('ADMIN');
    });
  });

  it('currentActor returns the whole actor (or null with none)', async () => {
    const actor = { userId: 'u1', username: 'carlos', ownerId: 'o1', role: 'USER', jti: 'j', exp: 1 };
    await withActor(cls, actor, () => {
      expect(svc.currentActor()).toEqual(actor);
    });
    await cls.run(async () => {
      expect(svc.currentActor()).toBeNull();
    });
  });

  it('ownerFilter is {ownerId} for USER and for ADMIN (no more {} bypass)', async () => {
    await withActor(cls, { ownerId: 'o1', role: 'USER' }, () => {
      expect(svc.ownerFilter()).toEqual({ ownerId: 'o1' });
    });
    await withActor(cls, { ownerId: 'oAdmin', role: 'ADMIN' }, () => {
      expect(svc.ownerFilter()).toEqual({ ownerId: 'oAdmin' });
    });
  });

  it('acting-as: an ADMIN with actingAsOwnerId scopes to the target for filter and currentOwnerId', async () => {
    await withActor(cls, { ownerId: 'oAdmin', role: 'ADMIN', actingAsOwnerId: 'oTarget' }, () => {
      expect(svc.ownerFilter()).toEqual({ ownerId: 'oTarget' });
      expect(svc.currentOwnerId()).toBe('oTarget');
      expect(svc.currentRole()).toBe('ADMIN'); // role is the REAL role, unaffected by acting-as
      expect(svc.currentActingAsOwnerId()).toBe('oTarget');
    });
  });

  it('currentActingAsOwnerId is null when not impersonating', async () => {
    await withActor(cls, { ownerId: 'o1', role: 'ADMIN' }, () => {
      expect(svc.currentActingAsOwnerId()).toBeNull();
    });
  });

  it('currentOwnerId throws with no actor', async () => {
    await cls.run(async () => {
      expect(() => svc.currentOwnerId()).toThrow();
    });
  });
});
