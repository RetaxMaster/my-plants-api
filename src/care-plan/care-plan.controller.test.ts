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

describe('CarePlanController.recompute role gating', () => {
  it('ADMIN recomputes the whole system', async () => {
    const { ctrl, recomputeAll, recomputeOwner, run } = setup();
    await run(actor('owner-1', 'ADMIN'), () => ctrl.recompute());
    expect(recomputeAll).toHaveBeenCalledTimes(1);
    expect(recomputeOwner).not.toHaveBeenCalled();
  });

  it('USER recomputes only their own garden', async () => {
    const { ctrl, recomputeAll, recomputeOwner, run } = setup();
    await run(actor('owner-1', 'USER'), () => ctrl.recompute());
    expect(recomputeOwner).toHaveBeenCalledWith('owner-1');
    expect(recomputeAll).not.toHaveBeenCalled();
  });

  it('today is scoped to the acting actor owner', async () => {
    const { ctrl, todaysTasks, run } = setup();
    await run(actor('owner-9', 'USER'), () => ctrl.today());
    expect(todaysTasks).toHaveBeenCalledWith('owner-9');
  });
});
