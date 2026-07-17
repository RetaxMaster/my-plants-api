import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OwnerService } from '../owner/owner.service.js';
import { DOCTOR_ALLOWED_KEY } from './doctor-scope.decorator.js';

// Global guard, registered AFTER JwtAuthGuard so the Actor is already in CLS. It acts ONLY on a
// `scope:'doctor'` token; every other request passes untouched. For a doctor token it DEFAULT-DENIES every
// route except one marked @DoctorAllowed(), and on those it additionally requires `:id === token.plantId`
// — so the token NARROWS access and can never be replayed against another plant, sessions, users, or admin
// surfaces (Spec 3 §3.3). This is the inverse of an ordinary token (allowed everywhere its owner scope
// permits): a doctor claim only ever subtracts reach.
@Injectable()
export class DoctorScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly owner: OwnerService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const actor = this.owner.currentActor();
    if (actor?.scope !== 'doctor') return true; // not a doctor token → normal pipeline

    const allowed = this.reflector.getAllAndOverride<boolean>(DOCTOR_ALLOWED_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!allowed) throw new ForbiddenException('doctor-scoped token: route not permitted');

    const req = ctx.switchToHttp().getRequest();
    if (req.params?.id !== actor.plantId) {
      throw new ForbiddenException('doctor-scoped token: plant mismatch');
    }
    // Belt-and-braces: a doctor token is never an admin token, so it carries no acting-as; this makes the
    // "own owner only" intent explicit rather than implicit.
    if (actor.ownerId !== (actor.actingAsOwnerId ?? actor.ownerId)) {
      throw new ForbiddenException('doctor-scoped token: owner mismatch');
    }
    return true;
  }
}
