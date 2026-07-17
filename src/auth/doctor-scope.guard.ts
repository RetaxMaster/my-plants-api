import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
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
    // The pinned plant must actually belong to the token's owner — the REAL default-deny boundary, enforced
    // in the guard itself rather than left to the downstream handlers (Spec 3 §3.3: "requires :id ===
    // token.plantId AND that ownerId matches"). A signed doctor token always satisfies this, so it never
    // rejects a legitimate token; it fails closed if the pin/owner ever diverge (e.g. a re-parented plant).
    const plant = await this.prisma.plant.findFirst({
      where: { id: actor.plantId, ownerId: actor.ownerId },
      select: { id: true },
    });
    if (!plant) throw new ForbiddenException('doctor-scoped token: owner mismatch');
    return true;
  }
}
