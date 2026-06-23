import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanController } from './care-plan.controller.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });

function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const recomputeAll = vi.fn(async () => {});
  const recomputeOwner = vi.fn(async () => {});
  const todaysTasks = vi.fn(async () => []);
  const carePlan = { recomputeAll, recomputeOwner, todaysTasks } as any;
  const ctrl = new CarePlanController(carePlan, owner);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { ctrl, recomputeAll, recomputeOwner, todaysTasks, run };
}

describe('CarePlanController.recompute (effective-owner scoping)', () => {
  it('a USER recomputes their own garden', async () => {
    const { ctrl, recomputeAll, recomputeOwner, run } = setup();
    await run(actor('owner-1', 'USER'), () => ctrl.recompute());
    expect(recomputeOwner).toHaveBeenCalledWith('owner-1');
    expect(recomputeAll).not.toHaveBeenCalled();
  });

  it('an ADMIN recomputes their OWN garden by default (no all-owners recompute over HTTP)', async () => {
    const { ctrl, recomputeAll, recomputeOwner, run } = setup();
    await run(actor('owner-admin', 'ADMIN'), () => ctrl.recompute());
    expect(recomputeOwner).toHaveBeenCalledWith('owner-admin');
    expect(recomputeAll).not.toHaveBeenCalled();
  });

  it('an ADMIN acting-as recomputes the TARGET owner', async () => {
    const { ctrl, recomputeOwner, run } = setup();
    await run({ ...actor('owner-admin', 'ADMIN'), actingAsOwnerId: 'owner-2' }, () => ctrl.recompute());
    expect(recomputeOwner).toHaveBeenCalledWith('owner-2');
  });

  it('today is scoped to the acting actor owner', async () => {
    const { ctrl, todaysTasks, run } = setup();
    await run(actor('owner-9', 'USER'), () => ctrl.today());
    expect(todaysTasks).toHaveBeenCalledWith('owner-9');
  });
});
