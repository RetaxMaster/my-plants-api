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

  // Synchronous now (Phase 3): reads CLS instead of hitting the DB. The actor's ownerId is the
  // single owner a write must be stamped against and a USER's reads must be scoped to.
  currentOwnerId(): string {
    return this.require().ownerId;
  }

  currentRole(): 'USER' | 'ADMIN' {
    return this.require().role;
  }

  // Prisma `where` fragment for owner scoping by operation: a USER sees only their own rows; an
  // ADMIN sees every owner's rows ({} = no owner constraint). Use this for READS and for the
  // access check of single-row mutations — NOT for creation (creation always stamps currentOwnerId).
  ownerFilter(): { ownerId: string } | Record<string, never> {
    const a = this.require();
    return a.role === 'ADMIN' ? {} : { ownerId: a.ownerId };
  }
}
