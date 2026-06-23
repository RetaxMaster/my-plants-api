import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { ACTOR_KEY, type Actor } from './actor.js';

// Default-deny global guard: every route requires a valid bearer token unless explicitly marked
// @Public(). On success it writes the actor into CLS (read by OwnerService) and onto req.user
// (read by AuthController for /me and /logout).
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    const payload = await this.auth.verify(header.slice('Bearer '.length));
    const actor: Actor = {
      userId: payload.sub,
      username: payload.username,
      ownerId: payload.ownerId,
      role: payload.role,
      jti: payload.jti,
      exp: payload.exp,
    };
    // Acting As: honor X-Act-As-Owner ONLY for an ADMIN (a USER's header is ignored — no escalation).
    // Validate existence here so a bogus target fails with a controlled 403 instead of a later FK/500.
    const actAs = req.headers?.['x-act-as-owner'];
    if (actor.role === 'ADMIN' && typeof actAs === 'string' && actAs.trim().length > 0) {
      const target = actAs.trim();
      if (!(await this.auth.ownerExists(target))) {
        throw new ForbiddenException('Unknown act-as owner');
      }
      actor.actingAsOwnerId = target;
    }
    this.cls.set(ACTOR_KEY, actor);
    req.user = actor;
    return true;
  }
}
