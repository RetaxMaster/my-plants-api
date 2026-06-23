import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ACTOR_KEY, type Actor } from '../auth/actor.js';

@Injectable()
export class OwnerService {
  constructor(private readonly cls: ClsService) {}

  // The actor written into CLS by the JwtAuthGuard for this request, or null on a path that has
  // no authenticated actor (e.g. a @Public() route, or an owner-agnostic system job).
  currentActor(): Actor | null {
    return this.cls.get(ACTOR_KEY) ?? null;
  }

  private require(): Actor {
    const a = this.currentActor();
    if (!a) throw new UnauthorizedException('No authenticated actor');
    return a;
  }

  // The effective owner = the impersonation target when an ADMIN is acting-as, else the actor's
  // own owner. Trusting actor.actingAsOwnerId here is safe: the guard sets it ONLY for an ADMIN.
  private effectiveOwnerId(): string {
    const a = this.require();
    return a.actingAsOwnerId ?? a.ownerId;
  }

  // Synchronous (reads CLS). The single owner a write is stamped against and reads are scoped to.
  currentOwnerId(): string {
    return this.effectiveOwnerId();
  }

  currentRole(): 'USER' | 'ADMIN' {
    return this.require().role;
  }

  // Prisma `where` fragment for owner scoping. Always constrains by the EFFECTIVE owner — there is
  // no longer an unconstrained ADMIN branch (that was bug B7). Admin reach across owners now comes
  // ONLY from impersonation (actingAsOwnerId), never from a blanket {}.
  ownerFilter(): { ownerId: string } {
    return { ownerId: this.effectiveOwnerId() };
  }

  // The impersonation target, or null when not acting-as (for GET /auth/me).
  currentActingAsOwnerId(): string | null {
    return this.currentActor()?.actingAsOwnerId ?? null;
  }
}
