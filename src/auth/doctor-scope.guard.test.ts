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

function setup(actor: unknown, allowed: boolean) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(allowed) };
  const owner = { currentActor: () => actor };
  const guard = new DoctorScopeGuard(reflector as any, owner as any);
  return { guard, reflector };
}

describe('DoctorScopeGuard', () => {
  it('a non-doctor actor passes on ANY route, regardless of allowed metadata', () => {
    const { guard } = setup({ scope: undefined, role: 'USER' }, false);
    expect(guard.canActivate(fakeCtx('A'))).toBe(true);
  });

  it('doctor actor on a route with no @DoctorAllowed() (allowed=false) → default-deny (403)', () => {
    const { guard } = setup(doctorActor, false);
    expect(() => guard.canActivate(fakeCtx('A'))).toThrow(ForbiddenException);
  });

  it('doctor actor, allowed=true, :id different from the token plantId → plant-pin 403', () => {
    const { guard } = setup(doctorActor, true);
    expect(() => guard.canActivate(fakeCtx('B'))).toThrow(ForbiddenException);
  });

  it('doctor actor, allowed=true, :id matches the token plantId → passes', () => {
    const { guard } = setup(doctorActor, true);
    expect(guard.canActivate(fakeCtx('A'))).toBe(true);
  });

  it('no authenticated actor (null) → passes (not a doctor token)', () => {
    const { guard } = setup(null, false);
    expect(guard.canActivate(fakeCtx('A'))).toBe(true);
  });
});
