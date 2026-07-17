import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { DoctorScopeGuard } from './doctor-scope.guard.js';

const doctorActor = { scope: 'doctor' as const, plantId: 'A', ownerId: 'o1', role: 'USER' as const };

// Minimal ExecutionContext — the guard reads the request only via switchToHttp().getRequest(), and
// forwards getHandler()/getClass() straight to the (faked) Reflector.
function fakeCtx(id: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ params: { id } }) }),
  } as unknown as ExecutionContext;
}

// Fake Prisma: the pinned plant exists ONLY when queried for (id=plantId, ownerId) matching the doctor
// token — the real default-deny owner boundary the guard now enforces itself.
function setup(actor: unknown, allowed: boolean, ownedPlant = { id: 'A', ownerId: 'o1' }) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(allowed) };
  const owner = { currentActor: () => actor };
  const prisma = {
    plant: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; ownerId: string } }) =>
        where.id === ownedPlant.id && where.ownerId === ownedPlant.ownerId ? { id: ownedPlant.id } : null,
      ),
    },
  };
  const guard = new DoctorScopeGuard(reflector as any, owner as any, prisma as any);
  return { guard, reflector, prisma };
}

describe('DoctorScopeGuard', () => {
  it('a non-doctor actor passes on ANY route, regardless of allowed metadata', async () => {
    const { guard } = setup({ scope: undefined, role: 'USER' }, false);
    await expect(guard.canActivate(fakeCtx('A'))).resolves.toBe(true);
  });

  it('doctor actor on a route with no @DoctorAllowed() (allowed=false) → default-deny (403)', async () => {
    const { guard } = setup(doctorActor, false);
    await expect(guard.canActivate(fakeCtx('A'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('doctor actor, allowed=true, :id different from the token plantId → plant-pin 403', async () => {
    const { guard } = setup(doctorActor, true);
    await expect(guard.canActivate(fakeCtx('B'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('doctor actor, allowed=true, :id matches the token plantId → passes', async () => {
    const { guard } = setup(doctorActor, true);
    await expect(guard.canActivate(fakeCtx('A'))).resolves.toBe(true);
  });

  it('doctor actor, allowed=true, :id matches but the pinned plant is NOT owned by the token owner → 403', async () => {
    // Token pins plant A / owner o1, but the plant belongs to someone else now (re-parented / forged owner).
    const { guard } = setup(doctorActor, true, { id: 'A', ownerId: 'someone-else' });
    await expect(guard.canActivate(fakeCtx('A'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no authenticated actor (null) → passes (not a doctor token)', async () => {
    const { guard } = setup(null, false);
    await expect(guard.canActivate(fakeCtx('A'))).resolves.toBe(true);
  });
});
