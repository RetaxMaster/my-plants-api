import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OwnerService } from '../owner/owner.service.js';
import { ROLES_KEY, type AppRole } from './roles.decorator.js';

// Controller-scoped role gate. MUST be applied via @UseGuards(RolesGuard) (not globally) so it runs
// AFTER the global JwtAuthGuard has written the Actor into CLS. Enforces the REAL token role
// (Actor.role) — acting-as only changes the effective owner, never the role, so an impersonating
// ADMIN still passes an ADMIN gate.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly owner: OwnerService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // No @Roles metadata → this guard imposes no restriction (it only enforces where declared).
    if (!required || required.length === 0) return true;

    const actor = this.owner.currentActor();
    if (!actor) throw new UnauthorizedException('No authenticated actor');
    if (!required.includes(actor.role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
